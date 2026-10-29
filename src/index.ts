import { Plugin } from "@opencode/plugin"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { buildSummary } from "./compaction/build"
import {
  buildHandoffPrompt,
  cleanHandoff,
  fallbackHandoff,
  insertBlock,
  renderWindow,
  withTimeout,
} from "./compaction/handoff"
import { loadConfig, type BlackholeConfig, type ModelRef } from "./config"
import { captureRequest } from "./store/capture"
import { TranscriptStore } from "./store/transcript"
import { normalize } from "./vcc/core/normalize"
import { DEFAULT_CHARS_PER_TOKEN, estimateTokensFromChars } from "./vcc/core/token-estimate"
import { extractFiles } from "./vcc/extract/files"
import { runRecallCommand, runRecallTool } from "./recall/recall"
import { CooldownStore, runWithFallbacks } from "./memory/models"
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

    /**
     * Write one trace line. Failures here must never break a compaction.
     */
    const writeLog = (kind: string, data: Record<string, unknown>) => {
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

    const log = (kind: string, data: Record<string, unknown>) => {
      if (config().logLevel === "off") return
      writeLog(kind, data)
    }

    /**
     * The outcome of a compaction, per session.
     *
     * A compaction that OpenCode wrote with its own model looks exactly like a
     * normal compaction from the inside the session, so the decision is kept
     * where it can be asked for.
     */
    const outcomes = new Map<
      string,
      { outcome: string; reason?: string; tokens?: number; at: string }
    >()
    const recordOutcome = (sessionID: string, outcome: string, reason?: string, tokens?: number) => {
      outcomes.set(sessionID, { outcome, reason, tokens, at: new Date().toISOString() })
    }

    /**
     * Compaction decisions are always written, whatever the log level is.
     *
     * They are rare (one per compaction) and they are the only trace of a
     * compaction that handed itself back to OpenCode's summarizer - the one
     * failure mode a user cannot otherwise see.
     */
    const logOutcome = (kind: string, data: Record<string, unknown>) => {
      writeLog(kind, data)
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

    /**
     * The model each session is currently using.
     *
     * `ctx.session.get()` does not carry the model, so it is taken from the
     * request itself: the context hook and the compaction hook both see the
     * model the session is running with. Without this the session-model
     * fallback could never fire.
     */
    const sessionModels = new Map<string, { providerID: string; id: string }>()
    const rememberModel = (sessionID: string, model: unknown) => {
      const ref = model as { providerID?: string; id?: string } | undefined
      if (ref?.providerID && ref?.id) sessionModels.set(sessionID, { providerID: ref.providerID, id: ref.id })
    }

    const sessionModel = async (sessionID: string) => {
      const known = sessionModels.get(sessionID)
      if (known) return known
      try {
        const info: any = await ctx.session.get({ sessionID })
        const model = info?.model
        if (model?.providerID && model?.id) {
          const ref = { providerID: model.providerID, id: model.id }
          sessionModels.set(sessionID, ref)
          return ref
        }
      } catch {
        // Fall through: the session model is optional.
      }
      return undefined
    }

    /** The one way this plugin calls a model. */
    const generate = async (model: ModelRef, prompt: string) => {
      const result = await ctx.generate.text({ model, prompt })
      return result.text
    }

    /**
     * The handoff block: one model call for the narrative half of the
     * checkpoint - decisions and why, where the work stands, what happens
     * next, and the facts that are expensive to rediscover.
     *
     * Returns undefined when the call fails or times out; the deterministic
     * summary is a valid checkpoint on its own. When the model is unreachable
     * a smaller block is derived without one, so a checkpoint still says
     * where the work stands.
     */
    const runHandoff = async (options: {
      sessionID: string
      messages: readonly unknown[]
      sections: string
      previousSummary?: string
    }): Promise<string | undefined> => {
      const settings = config()
      const inputChars = Math.max(4_000, Math.round(settings.compaction.handoffInputMaxTokens * 4))
      const previousChars = Math.min(options.previousSummary?.length ?? 0, Math.floor(inputChars * 0.4))
      const sectionChars = Math.min(options.sections.length, Math.floor(inputChars * 0.25))
      const windowChars = Math.max(2_000, inputChars - previousChars - sectionChars)
      const prompt = buildHandoffPrompt({
        previousSummary: options.previousSummary?.slice(0, previousChars),
        sections: options.sections.slice(0, sectionChars),
        window: renderWindow(options.messages, windowChars),
      })

      let model: string | undefined
      // The block shares the summary budget with the deterministic sections,
      // so it can never push the checkpoint past the hard cap on its own.
      const blockBudget =
        Math.max(
          400,
          Math.min(settings.compaction.handoffMaxTokens, Math.floor(settings.compaction.maxSummaryTokens / 2)),
        ) * 4

      // One deadline for every attempt: a model that is slow must not hold
      // compaction open for the timeout once per retry.
      const deadline = Date.now() + settings.compaction.handoffTimeoutSeconds * 1_000
      const attemptOnce = async () => {
        const remaining = deadline - Date.now()
        if (remaining < 1_000) return undefined
        const run = await withTimeout(
          runWithFallbacks({
            models: [settings.compaction.handoffModel, ...settings.compaction.handoffFallbacks],
            prompt,
            call: generate,
            sessionModel: await sessionModel(options.sessionID),
            sessionFallback: settings.memory.sessionFallback,
            cooldowns,
            cooldownSeconds: settings.memory.cooldownSeconds,
            onFailure: (failed, error, retryable) =>
              log("handoff-model-failed", {
                sessionID: options.sessionID,
                model: `${failed.providerID}/${failed.id}`,
                retryable,
                error: String(error).slice(0, 200),
              }),
          }),
          remaining,
        )
        if (run) model = `${run.model.providerID}/${run.model.id}`
        return run
      }

      let run = await attemptOnce()
      let block = run ? cleanHandoff(run.text, blockBudget) : undefined
      // A reasoning model can spend the whole output budget thinking and
      // return no text at all. The free router picks a provider per request,
      // so one retry normally lands somewhere else; the deadline still wins.
      if (!block && run && deadline - Date.now() > 5_000) {
        log("handoff-retry", { sessionID: options.sessionID, model })
        run = await attemptOnce()
        block = run ? cleanHandoff(run.text, blockBudget) : undefined
      }
      if (block) {
        log("handoff", { sessionID: options.sessionID, model, chars: block.length })
        return block
      }

      const fallback = fallbackHandoff({
        summary: options.sections,
        messages: options.messages,
        previousSummary: options.previousSummary,
      })
      log("handoff-fallback", {
        sessionID: options.sessionID,
        model,
        chars: fallback?.length ?? 0,
        reason: run ? "unusable response" : "no model answered",
      })
      return fallback
    }

    const memory = new MemoryManager({
      state,
      cooldowns,
      config,
      generate,
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
      rememberModel(event.sessionID, (event as any).model)
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
      // Another plugin already produced a summary — leave it alone, but say
      // so: a compaction we did not write is the one thing a user cannot see
      // from the session itself.
      if (event.result) {
        recordOutcome(event.sessionID, "skipped", "another plugin produced a summary")
        logOutcome("compaction-skipped", { sessionID: event.sessionID, reason: "another plugin produced a summary" })
        return
      }

      try {
        const settings = config()
        if (!settings.enabled || !settings.compaction.enabled) {
          recordOutcome(event.sessionID, "disabled", "blackhole is disabled")
          return
        }

        rememberModel(event.sessionID, (event as any).model)

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

        // The handoff block: the narrative the deterministic sections cannot
        // carry. Additive - a failed call leaves the deterministic summary
        // untouched - and a carried checkpoint has nothing new to narrate.
        let handoff: string | undefined
        if (settings.compaction.handoff && !result.carried) {
          try {
            handoff = await runHandoff({
              sessionID: event.sessionID,
              messages: event.messages as unknown[],
              sections: result.summary ?? "",
              previousSummary: result.previousSummary,
            })
          } catch (err) {
            // Never a reason to fail a compaction.
            log("handoff-error", { sessionID: event.sessionID, error: String(err) })
          }
        }

        let summary = result.summary
        if (handoff) summary = summary ? insertBlock(summary, handoff) : handoff

        if (!summary) {
          // The safety valve: OpenCode's own summarizer takes over. Record it,
          // because from the session this is invisible - it just looks like a
          // slow, model-written summary.
          recordOutcome(event.sessionID, "fallback", result.rejected ?? "no usable content")
          logOutcome("compaction-fallback", {
            sessionID: event.sessionID,
            reason: result.rejected,
            messageCount: event.messages?.length ?? 0,
            handoff: Boolean(handoff),
          })
          return
        }

        // Durable memory rides along with the summary, so a compaction never
        // loses what the session learned.
        if (settings.memory.enabled) {
          try {
            const block = memory.summaryMemoryBlock(event.sessionID)
            if (block) summary = `${summary}\n\n${block}`
          } catch {
            // Reflections are an addition, never a reason to fail a compaction.
          }
        }

        const tokens = estimateTokensFromChars(summary.length, DEFAULT_CHARS_PER_TOKEN)
        event.result = { summary }
        recordOutcome(
          event.sessionID,
          result.summary ? "deterministic" : "handoff-only",
          handoff ? "with handoff block" : undefined,
          tokens,
        )
        logOutcome("compaction", {
          sessionID: event.sessionID,
          model: event.model,
          messageCount: event.messages?.length ?? 0,
          summaryTokens: tokens,
          handoff: Boolean(handoff),
          handoffOnly: !result.summary,
          hadPreviousSummary: Boolean(result.previousSummary),
        })
      } catch (err) {
        // A bug here must never fail a compaction: leave the result unset and
        // let OpenCode fall back to its own summarizer. Say what happened.
        recordOutcome(event.sessionID, "error", String(err))
        logOutcome("compaction-error", { sessionID: event.sessionID, error: String(err) })
      }
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
        description: "Compact this session now with blackhole's checkpoint (no summarizer call)",
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
          const last = outcomes.get(sessionID)
          if (last) {
            // Whether the last compaction was ours or OpenCode's own model is
            // invisible from inside the session, so it is reported here.
            const detail = last.reason ? ` (${last.reason})` : ""
            const size = last.tokens ? `, ${last.tokens} tokens` : ""
            lines.push(`- last compaction: ${last.outcome}${detail}${size} at ${last.at}`)
          }
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
