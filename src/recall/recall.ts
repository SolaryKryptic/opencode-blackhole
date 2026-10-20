/**
 * Recall for OpenCode.
 *
 * The vcc core ships the search, ranking and formatting; this module wires
 * them to OpenCode's session transcript. OpenCode has no branch/lineage model
 * that a plugin can see, so scope handling is simplified: the transcript is
 * the whole session, and `scope:'all'` is accepted for compatibility.
 */
import { expandEntryFile } from "../vcc/core/drill-down"
import { formatRecallOutput, formatTouchedOutput, TOUCHED_PAGE_SIZE } from "../vcc/core/format-recall"
import { loadMessages, type LoadedMessages } from "../vcc/load-messages"
import {
  parseCommandRequest,
  parseToolRequest,
  type RecallRequest,
  type RecallToolParams,
} from "../vcc/core/recall-request"
import { getTouchedFiles, searchEntriesDetailed, type SearchHit } from "../vcc/core/search-entries"
import type { TranscriptStore } from "../store/transcript"

const SEARCH_PAGE_SIZE = 5
const RANGE_PAGE_SIZE = 20
const RECENT_COUNT = 25
const PAIRED_RESULT_CHARS = 4000
const WRITES_FILE = /write|edit|patch/i

/**
 * A recall response has a character budget.
 *
 * One stored message can be enormous (a file read, a long command output), and
 * a recall that returns it verbatim would flood the context it was meant to
 * help with. The budget is shared across the entries of a response, and each
 * entry's lines share their slice of it — so a page of twenty small hits stays
 * readable and one giant hit cannot swallow the page.
 */
export interface RecallOptions {
  /** Maximum characters for the whole response. 0 disables the cap. */
  maxChars: number
}

const clipText = (text: string, limit: number): string => {
  if (limit <= 0 || text.length <= limit) return text
  return `${text.slice(0, limit)}…[clipped ${text.length - limit} chars]`
}

/** Share the response budget across the entries, and each entry's lines. */
const clipEntries = <T extends { summary: string; snippet?: string }>(
  entries: T[],
  budget: number,
): T[] => {
  if (budget <= 0 || entries.length === 0) return entries
  const perEntry = Math.max(200, Math.floor(budget / entries.length))
  return entries.map((entry) => {
    const body = entry.snippet ?? entry.summary
    if (body.length <= perEntry) return entry
    // Give every line of the entry a slice, so one long line cannot take it
    // all and the rest of the entry stays visible.
    const lines = body.split("\n")
    const perLine = Math.max(80, Math.floor(perEntry / Math.max(1, lines.length)))
    const clipped = lines.map((line) => clipText(line, perLine)).join("\n")
    const next = { ...entry, summary: clipText(clipped, perEntry) }
    if (entry.snippet !== undefined) next.snippet = clipText(clipped, perEntry)
    return next
  })
}

/** The last line of defence: the formatted response itself never exceeds the budget. */
const clipResponse = (text: string, budget: number): string => {
  if (budget <= 0 || text.length <= budget) return text
  return `${text.slice(0, budget)}\n…[response clipped at ${budget} of ${text.length} chars]`
}

/**
 * Rendered views are cached per session.
 *
 * Rendering the transcript means summarizing every message, which is wasted
 * work when the same session is recalled several times and nothing was
 * captured in between. The store's version counter tells us when to rebuild.
 * The cache is capped, so it cannot become a second copy of every session.
 */
const VIEW_CACHE_SIZE = 4
const viewCache = new Map<string, { version: number; full: boolean; view: LoadedMessages }>()

const view = (store: TranscriptStore, sessionID: string, full: boolean): LoadedMessages => {
  const transcript = store.read(sessionID)
  const cached = viewCache.get(sessionID)
  if (cached && cached.version === transcript.version && cached.full === full) {
    viewCache.delete(sessionID)
    viewCache.set(sessionID, cached)
    return cached.view
  }
  const result = loadMessages(
    transcript.messages.map((entry) => entry.message),
    full,
  )
  viewCache.delete(sessionID)
  viewCache.set(sessionID, { version: transcript.version, full, view: result })
  while (viewCache.size > VIEW_CACHE_SIZE) {
    const oldest = viewCache.keys().next().value
    if (oldest === undefined) break
    viewCache.delete(oldest)
  }
  return result
}

const ignoredNote = (request: RecallRequest): string => {
  const reasons: Record<string, string> = {
    drill: "a #N:path query runs alone",
    touched: "mode:'touched' runs alone",
    expand: "expand runs alone; send the rest in a separate call",
    range: "range runs alone; send the rest in a separate call",
    search: "",
    recent: "page applies to query or range results",
  }
  return (request.dropped?.length ? `Ignored: ${request.dropped.join(", ")}.\n\n` : "") +
    (request.ignored?.length ? `Ignored: ${request.ignored.join(", ")} (${reasons[request.action.kind]}).\n\n` : "")
}

const runExpand = (
  indices: number[],
  store: TranscriptStore,
  sessionID: string,
  options: RecallOptions,
): string => {
  const { rendered, rawMessages } = view(store, sessionID, true)
  const invalid = indices.filter((i) => !rendered.some((m) => m.index === i))
  if (invalid.length > 0) return `Cannot expand indices outside session history: ${invalid.join(", ")}`

  const out: SearchHit[] = []
  for (const index of indices) {
    const pos = rendered.findIndex((m) => m.index === index)
    if (pos < 0) continue
    const entry = rendered[pos]
    out.push(entry)

    // Bring the tool results of an expanded call along, so the agent does not
    // have to know the result sits at a later #N.
    const raw = rawMessages[pos] as any
    const ids = new Set<string>(
      Array.isArray(raw?.content)
        ? raw.content
            .filter((part: any) => part?.type === "toolCall" && typeof part.id === "string")
            .map((part: any) => part.id)
        : [],
    )
    if (ids.size === 0) continue
    for (let j = pos + 1; j < rendered.length && ids.size > 0; j++) {
      const result = rawMessages[j] as any
      if (result?.role === "assistant") break
      if (result?.role !== "toolResult" || !ids.has(result.toolCallId)) continue
      ids.delete(result.toolCallId)
      const res = rendered[j]
      if (indices.includes(res.index)) continue
      out.push({
        ...res,
        summary:
          res.summary.length > PAIRED_RESULT_CHARS
            ? `${res.summary.slice(0, PAIRED_RESULT_CHARS)}\n...[result of #${entry.index} clipped at ${PAIRED_RESULT_CHARS} of ${res.summary.length} chars; expand:[${res.index}] for all of it]`
            : res.summary,
      })
    }
  }

  const header = `Expanded ${indices.map((i) => `#${i}`).join(", ")}`
  return clipResponse(
    formatRecallOutput(clipEntries(out, options.maxChars), undefined, header),
    options.maxChars,
  )
}

const runRange = (
  range: unknown[],
  page: number,
  store: TranscriptStore,
  sessionID: string,
  options: RecallOptions,
): string => {
  const [from, to] = range
  if (
    range.length !== 2 ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    (from as number) < 0 ||
    (from as number) > (to as number)
  ) {
    return `Invalid range ${JSON.stringify(range)}: use range:[from, to] with two #N indices, from <= to.`
  }

  const lo = from as number
  const { rendered } = view(store, sessionID, false)
  const entries = rendered.filter((m) => m.index >= lo && m.index <= (to as number))
  if (entries.length === 0) {
    const last = rendered[rendered.length - 1]
    return `No messages #${lo}..#${to} in session history${last ? ` (last entry is #${last.index})` : ""}.`
  }

  const lastIndex = rendered[rendered.length - 1].index
  const clamped = (to as number) > lastIndex
  const hi = clamped ? lastIndex : (to as number)
  const totalPages = Math.ceil(entries.length / RANGE_PAGE_SIZE)
  const counts = `${entries.length} messages${clamped ? `, #${hi} is the last entry` : ""}`
  if (page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (#${lo}..#${hi}: ${counts}). Use a page between 1 and ${totalPages}.`
  }
  const start = (page - 1) * RANGE_PAGE_SIZE
  const header =
    totalPages > 1 ? `Range #${lo}..#${hi}, page ${page}/${totalPages} (${counts})` : `Range #${lo}..#${hi} (${counts})`
  const footer =
    page < totalPages ? `\n--- Use range:[${lo}, ${hi}] page:${page + 1} for the next ${RANGE_PAGE_SIZE} ---` : ""
  return (
    clipResponse(
      formatRecallOutput(
        clipEntries(entries.slice(start, start + RANGE_PAGE_SIZE), options.maxChars),
        undefined,
        header,
      ),
      options.maxChars,
    ) + footer
  )
}

const runTouched = (
  page: number | undefined,
  store: TranscriptStore,
  sessionID: string,
  options: RecallOptions,
): string => {
  const { rendered, rawMessages } = view(store, sessionID, false)
  const touched = getTouchedFiles(rawMessages, rendered)
  const text = formatTouchedOutput(touched, page)
  const start = (Math.max(1, page ?? 1) - 1) * TOUCHED_PAGE_SIZE
  for (const file of touched.slice(start, start + TOUCHED_PAGE_SIZE)) {
    const write = [...file.entries].reverse().find((entry) => WRITES_FILE.test(entry.toolName))
    if (!write) continue
    const name = file.path.replace(/\\/g, "/").split("/").pop()
    return clipResponse(`${text}\n--- File content at an entry: query:'#${write.index}:${name}' ---`, options.maxChars)
  }
  return text
}

const runSearch = (
  query: string,
  page: number,
  store: TranscriptStore,
  sessionID: string,
  options: RecallOptions,
): string => {
  const { rendered, rawMessages } = view(store, sessionID, false)
  const { hits, totalBeforeCap, truncated } = searchEntriesDetailed(rendered, rawMessages, query)
  const totalPages = Math.ceil(hits.length / SEARCH_PAGE_SIZE)
  const truncationNote = truncated
    ? ` — showing ${hits.length} of ${totalBeforeCap} matches, refine your query for more precise results`
    : ""
  if (hits.length > 0 && page > totalPages) {
    return `Page ${page} is outside the available range 1-${totalPages} (${hits.length} matches${truncationNote}). Use a page between 1 and ${totalPages}.`
  }
  const start = (page - 1) * SEARCH_PAGE_SIZE
  const pageHits = hits.slice(start, start + SEARCH_PAGE_SIZE)
  const header =
    totalPages > 1
      ? `Page ${page}/${totalPages} (${hits.length} total matches${truncationNote})`
      : `${hits.length} matches${truncationNote}`
  const footer = page < totalPages ? `\n--- Next page: page:${page + 1} ---` : ""
  return (
    clipResponse(formatRecallOutput(clipEntries(pageHits, options.maxChars), query, header), options.maxChars) + footer
  )
}

const runAction = (
  request: RecallRequest,
  store: TranscriptStore,
  sessionID: string,
  options: RecallOptions,
): string => {
  const { action } = request
  switch (action.kind) {
    case "drill": {
      const { rendered } = view(store, sessionID, false)
      const target = action.target
      const offPath = !rendered.some((m) => m.index === target.index)
      const messages = store.read(sessionID).messages.map((entry) => entry.message)
      return clipResponse(
        (offPath ? "Entry is not in the recorded session history.\n\n" : "") +
          expandEntryFile(messages, target.index, target.pathPattern, target.full, target.offset, target.limit),
        options.maxChars,
      )
    }
    case "touched":
      return runTouched(action.page, store, sessionID, options)
    case "expand":
      return runExpand(action.indices, store, sessionID, options)
    case "range":
      return runRange(action.range, action.page, store, sessionID, options)
    case "search":
      return runSearch(action.query, action.page, store, sessionID, options)
    case "recent": {
      const { rendered } = view(store, sessionID, false)
      return clipResponse(
        formatRecallOutput(clipEntries(rendered.slice(-RECENT_COUNT), options.maxChars), action.query),
        options.maxChars,
      )
    }
  }
}

export const runRecall = (
  store: TranscriptStore,
  sessionID: string,
  request: RecallRequest,
  options: RecallOptions = { maxChars: 0 },
): string => ignoredNote(request) + runAction(request, store, sessionID, options)

/** Run a recall from tool parameters. */
export const runRecallTool = (
  store: TranscriptStore,
  sessionID: string,
  params: RecallToolParams,
  options: RecallOptions = { maxChars: 0 },
): string => runRecall(store, sessionID, parseToolRequest(params), options)

/** Run a recall from a command's argument string. */
export const runRecallCommand = (
  store: TranscriptStore,
  sessionID: string,
  args: string,
  options: RecallOptions = { maxChars: 0 },
): string => runRecall(store, sessionID, parseCommandRequest(args), options)
