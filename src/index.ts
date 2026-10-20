import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildSummary } from "./compaction/build"
import { loadConfig, type BlackholeConfig } from "./config"
import { captureRequest } from "./store/capture"
import { TranscriptStore } from "./store/transcript"
import { normalize } from "./vcc/core/normalize"
import { extractFiles } from "./vcc/extract/files"
import { runRecallCommand, runRecallTool } from "./recall/recall"
import { CooldownStore } from "./memory/models"
import { MemoryLedger } from "./memory/ledger"
import { MemoryManager } from "./memory/manager"
import { directoryKey, listProjectDirs, projectStateDir, stateBase } from "./state/paths"

const DAY_MS = 24 * 60 * 60 * 1000
/** The trace log is trimmed once it grows past this. */
const MAX_LOG_BYTES = 5 * 1024 * 1024

/** Remove a file that has not been touched for `olderThanMs`. */
const sweepFile = (path: string, olderThanMs: number, now = Date.now()): number => {
  try {
    const stats = statSync(path)
    if (now - stats.mtimeMs < olderThanMs) return 0
    rmSync(path, { force: true })
    return 1
  } catch {
    return 0
  }
}

/**
 * opencode-blackhole — deterministic compaction (and, later, observational
 * memory) for OpenCode.
 *
 * The compaction hook replaces OpenCode's LLM summarizer with the ported vcc
 * pipeline: same input, same output, no model call. If the extraction yields
 * nothing useful we leave the hook result unset, and OpenCode falls back to
 * its own summarizer.
 */
export default Plugin.define({
  id: "opencode-blackhole",
  async setup(ctx) {
    const directory = ctx.location.directory
    const config = (): BlackholeConfig => loadConfig({ directory, options: ctx.options })

    // The state lives in the user's home directory, next to OpenCode's own
    // data, grouped by project id — not inside the project.
    const base = stateBase()
    const fallbackKey = directoryKey(directory)
    const logFile = join(base, "blackhole.log")
    mkdirSync(base, { recursive: true })

    /** session id → project key. */
    const sessionKeys = new Map<string, string>()
    /** project key → its store and ledger. */
    const projectStates = new Map<string, { store: TranscriptStore; ledger: MemoryLedger }>()

    const resolveKey = async (sessionID: string): Promise<string> => {
      const cached = sessionKeys.get(sessionID)
      if (cached) return cached
      let key = fallbackKey
      try {
        const info: any = await ctx.session.get({ sessionID })
        // The project id survives moving or renaming the project; the
        // directory path does not.
        if (info?.projectID) key = info.projectID
      } catch {
        // Fall back to the directory key.
      }
      sessionKeys.set(sessionID, key)
      return key
    }

    const stateFor = (key: string) => {
      let entry = projectStates.get(key)
      if (!entry) {
        const dir = projectStateDir(base, key)
        entry = {
          store: new TranscriptStore(join(dir, "transcripts"), {
            maxCachedSessions: config().limits.maxCachedSessions,
            maxMessageChars: config().limits.maxMessageChars,
          }),
          ledger: new MemoryLedger(join(dir, "memory"), {
            maxCachedSessions: config().limits.maxCachedSessions,
            maxFileBytes: config().limits.maxLedgerBytes,
          }),
        }
        projectStates.set(key, entry)
      }
      return entry
    }

    /** The state of a session, resolved synchronously. */
    const state = (sessionID: string) => stateFor(sessionKeys.get(sessionID) ?? fallbackKey)

    /** Resolve a session's project, then return its state. */
    const ensure = async (sessionID: string) => stateFor(await resolveKey(sessionID))

    const log = (kind: string, data: Record<string, unknown>) => {
      if (config().logLevel === "off") return
      try {
        // Keep the trace bounded: a long session would otherwise grow the log
        // without limit.
        if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
          const lines = readFileSync(logFile, "utf8").split("\n")
          writeFileSync(logFile, lines.slice(Math.floor(lines.length / 2)).join("\n"))
        }
        appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), kind, ...data }) + "\n")
      } catch {
        // Logging must never break a compaction.
      }
    }

    const cooldowns = new CooldownStore(base)

    // Move any state written by an older version (which kept it inside the
    // project) into the global store, keyed by the session's project.
    try {
      const legacy = join(directory, ".opencode", "blackhole")
      if (existsSync(legacy)) {
        let moved = 0
        for (const kind of ["transcripts", "memory"]) {
          const source = join(legacy, kind)
          if (!existsSync(source)) continue
          for (const file of readdirSync(source)) {
            if (!file.endsWith(".jsonl")) continue
            const sessionID = file.replace(/\.jsonl$/, "")
            const key = await resolveKey(sessionID)
            const dest = join(projectStateDir(base, key), kind)
            mkdirSync(dest, { recursive: true })
            const target = join(dest, file)
            if (existsSync(target)) continue
            try {
              renameSync(join(source, file), target)
              moved++
            } catch {
              // Leave a file we cannot move where it is.
            }
          }
        }
        if (moved > 0) log("state-migrated", { moved, from: legacy, to: base })
        // Drop what is left of the old directory.
        try {
          rmSync(legacy, { recursive: true, force: true })
        } catch {
          // Not fatal: the old files are inert.
        }
      }
    } catch (err) {
      log("state-migration-failed", { error: String(err) })
    }

    // Expire old state once, when the plugin starts. Transcripts duplicate
    // what OpenCode already stores in the session record, so they expire
    // quickly; ledgers hold the session's memory and are kept much longer.
    try {
      const settings = config().retention
      for (const dir of listProjectDirs(base)) {
        if (settings.transcriptDays > 0) {
          const removed = TranscriptStore.sweepDir(join(dir, "transcripts"), settings.transcriptDays * DAY_MS)
          if (removed > 0) log("retention", { kind: "transcript", removed })
        }
        if (settings.memoryDays > 0) {
          const removed = MemoryLedger.sweepDir(join(dir, "memory"), settings.memoryDays * DAY_MS)
          if (removed > 0) log("retention", { kind: "memory", removed })
        }
      }
      if (settings.logDays > 0) {
        const removed = sweepFile(logFile, settings.logDays * DAY_MS)
        if (removed > 0) log("retention", { kind: "log", removed })
      }
    } catch (err) {
      log("retention-failed", { error: String(err) })
    }

    const sessionModel = async (sessionID: string) => {
      try {
        const info: any = await ctx.session.get({ sessionID })
        const model = info?.model
        if (model?.providerID && model?.id) return { providerID: model.providerID, id: model.id }
      } catch {
        // Fall through: the session model is optional.
      }
      return undefined
    }

    const memory = new MemoryManager({
      state,
      cooldowns,
      config,
      generate: async (model, prompt) => {
        const result = await ctx.generate.text({ model, prompt })
        return result.text
      },
      sessionModel,
      notify: (sessionID, text) => {
        void ctx.session.synthetic({ sessionID, text })
      },
      log,
    })

    // Record every model request so the session has a full transcript for
    // recall and for session-global `#N` references, and inject the durable
    // memory into the system prompt.
    await ctx.session.hook("context", async (event) => {
      if (!config().enabled) return
      try {
        const { store } = await ensure(event.sessionID)
        captureRequest(store, event.sessionID, event.messages as unknown[])
      } catch (err) {
        log("capture-failed", { sessionID: event.sessionID, error: String(err) })
      }
      if (!config().memory.enabled) return
      try {
        const block = memory.memoryBlock(event.sessionID)
        if (block) {
          event.system.push({ type: "text", text: block })
          log("memory-injected", { sessionID: event.sessionID, chars: block.length })
        }
      } catch (err) {
        log("memory-inject-failed", { sessionID: event.sessionID, error: String(err) })
      }
    })

    // Turn end: run the memory workers when their thresholds are met.
    const controller = new AbortController()
    const seenEventTypes = new Set<string>()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const type = (event as any)?.type
          if (!seenEventTypes.has(type)) {
            seenEventTypes.add(type)
            log("event-type", { type })
          }
          if (type !== "session.execution.succeeded") continue
          const sessionID = (event as any)?.data?.sessionID ?? (event as any)?.sessionID
          log("turn-end", { sessionID })
          if (!sessionID) continue
          void (async () => {
            try {
              await ensure(sessionID)
              await memory.onTurnEnd(sessionID)
            } catch (err) {
              log("memory-error", { sessionID, error: String(err) })
            }
          })()
        }
      } catch (err) {
        log("event-stream-error", { error: String(err) })
      }
    })()

    await ctx.session.hook("compaction", async (event) => {
      // Another plugin already produced a summary — leave it alone.
      if (event.result) return

      const settings = config()
      if (!settings.enabled || !settings.compaction.enabled) return

      const { store } = await ensure(event.sessionID)

      // The compaction request carries the newest exchange OpenCode kept
      // verbatim, which we have not seen in a request yet. Capturing it keeps
      // the transcript complete at the point where it matters most.
      try {
        captureRequest(store, event.sessionID, event.messages as unknown[])
      } catch (err) {
        log("capture-failed", { sessionID: event.sessionID, error: String(err) })
      }

      const transcript = store.read(event.sessionID)
      const resolveIndex = (id: string) => transcript.indexById.get(id)

      // Authoritative file activity across the whole session, including the
      // newest exchange OpenCode retained verbatim (it is not part of the
      // summarization request).
      let fileOps
      try {
        const blocks = normalize(transcript.messages.map((entry) => entry.message))
        const files = extractFiles(blocks)
        fileOps = {
          readFiles: [...files.read],
          modifiedFiles: [...files.modified],
          createdFiles: [...files.created],
        }
      } catch {
        fileOps = undefined
      }

      const result = buildSummary({
        messages: event.messages as unknown[],
        resolveIndex,
        fileOps,
        briefTokens: settings.compaction.brief ? settings.compaction.briefTokens : 0,
        maxSummaryTokens: settings.compaction.maxSummaryTokens,
        extraNote: settings.compaction.extraNote,
      })

      if (!result.summary) {
        log("compaction-fallback", {
          sessionID: event.sessionID,
          reason: result.rejected,
          messageCount: event.messages?.length ?? 0,
        })
        return
      }

      // Durable reflections ride along with the summary, so a compaction never
      // loses what the session learned.
      let summary = result.summary
      if (settings.memory.enabled) {
        try {
          const reflections = memory.reflectionsBlock(event.sessionID)
          if (reflections) summary = `${summary}\n\n${reflections}`
        } catch {
          // Reflections are an addition, never a reason to fail a compaction.
        }
      }

      event.result = { summary }
      log("compaction", {
        sessionID: event.sessionID,
        model: event.model,
        messageCount: event.messages?.length ?? 0,
        summaryTokens: result.tokens,
        hadPreviousSummary: Boolean(result.previousSummary),
      })
    })

    // The recall tool: search the session transcript, including anything a
    // compaction dropped.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "blackhole_recall",
        description: [
          "Recall earlier parts of this session, including anything dropped by compaction.",
          "Use it before saying the context is gone.",
          "",
          "Pick one per call:",
          "- query: keyword search (regex works), 5 results per page.",
          "- range: [from, to]: entries #from..#to in order, 20 per page.",
          "- expand: [N, ...]: full untruncated text of those entries.",
          "- mode: 'touched': files worked on, with entry indices.",
          "- query '#N:path': file content from entry N ('#N:path:full' for all lines).",
          "",
          "Add to any of them:",
          "- page: next page of query, range or touched results.",
          "- scope: 'all' reads the whole session.",
          "",
          "#N is the number shown in summary refs like (#12) and in recall results.",
          "Only the current session is searchable.",
        ].join("\n"),
        input: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "What to recall, in plain keywords (e.g. 'redis cache decision'). Multi-word queries are ranked by relevance. A regex pattern also works. '#N:path' instead shows a file's content from entry N.",
            },
            range: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              description:
                "[from, to]: every entry from #from to #to (inclusive) in order, 20 per page. #N is the number in summary refs like (#12) and in recall results.",
            },
            expand: {
              type: "array",
              items: { type: "number" },
              description:
                "#N indices to return full untruncated content for (from summary refs like (#12) or recall results).",
            },
            page: {
              type: "number",
              description: "Page number (1-based) for query, range or touched results. Default: 1.",
            },
            scope: {
              type: "string",
              enum: ["lineage", "all"],
              description:
                "Default 'lineage' covers the active conversation path. Use 'all' to also reach messages from other branches.",
            },
            mode: {
              type: "string",
              enum: ["hybrid", "touched"],
              description:
                "hybrid (default) = normal recall; touched = files worked on, by path, with entry indices.",
            },
          },
          additionalProperties: false,
        },
        execute: async (input: any, context: any) => {
          const { store } = await ensure(context.sessionID)
          const text = runRecallTool(store, context.sessionID, input ?? {}, {
            maxChars: config().recall.responseMaxChars,
          })
          return { content: text }
        },
      })
    })

    // Commands. OpenCode's command API cannot return text directly, so the
    // output is delivered into the session as a synthetic message.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "blackhole",
        description: "Compact this session now with blackhole's deterministic summary (no model call)",
        execute: async ({ sessionID }) => {
          await ctx.session.compact({ sessionID })
        },
      })
      editor.add({
        name: "blackhole-recall",
        description: "Search this session's history: /blackhole-recall <query> [page:N] [scope:all]",
        execute: async ({ sessionID, prompt }) => {
          const { store } = await ensure(sessionID)
          const text = runRecallCommand(store, sessionID, prompt?.text ?? "", {
            maxChars: config().recall.responseMaxChars,
          })
          await ctx.session.synthetic({ sessionID, text })
        },
      })
      editor.add({
        name: "blackhole-memory",
        description: "Show blackhole's memory status for this session",
        execute: async ({ sessionID }) => {
          const { ledger } = await ensure(sessionID)
          const status = memory.status(sessionID)
          const state = ledger.read(sessionID)
          const lines = [
            "# Blackhole memory",
            "",
            `- observations: ${status.observations}`,
            `- reflections: ${status.reflections}`,
            `- dropped: ${status.dropped}`,
            `- observed through entry: #${status.observedThrough}`,
            `- pending: ~${status.pendingTokens} tokens`,
            `- state: ${projectStateDir(base, sessionKeys.get(sessionID) ?? fallbackKey)}`,
          ]
          if (state.observations.length > 0) {
            lines.push("", "## Observations")
            for (const observation of state.observations) lines.push(`- ${observation.text}`)
          }
          if (state.reflections.length > 0) {
            lines.push("", "## Reflections")
            for (const reflection of state.reflections) lines.push(`- ${reflection.text}`)
          }
          await ctx.session.synthetic({ sessionID, text: lines.join("\n") })
        },
      })
      editor.add({
        name: "blackhole-export",
        description: "Export this session's memory as markdown: /blackhole-export [out:<path>.md]",
        execute: async ({ sessionID, prompt }) => {
          const { ledger } = await ensure(sessionID)
          const state = ledger.read(sessionID)
          const args = prompt?.text ?? ""
          const outMatch = /out:(\S+)/.exec(args)
          const body = [
            "# Blackhole memory export",
            "",
            "## Reflections",
            ...(state.reflections.length > 0
              ? state.reflections.map((reflection) => `- ${reflection.text}`)
              : ["- (none)"]),
            "",
            "## Observations",
            ...(state.observations.length > 0
              ? state.observations.map((observation) => `- ${observation.text}`)
              : ["- (none)"]),
            "",
          ].join("\n")
          if (outMatch) {
            const path = outMatch[1]
            try {
              mkdirSync(dirname(path), { recursive: true })
              writeFileSync(path, body)
              await ctx.session.synthetic({ sessionID, text: `Memory exported to ${path}` })
              return
            } catch (error) {
              await ctx.session.synthetic({ sessionID, text: `Export failed: ${String(error)}` })
              return
            }
          }
          await ctx.session.synthetic({ sessionID, text: body })
        },
      })
    })
  },
})
