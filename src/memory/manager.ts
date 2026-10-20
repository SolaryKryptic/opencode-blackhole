/**
 * The memory manager: decides when the workers run, runs them with the
 * configured model chain, and renders the memory that gets injected back into
 * the session.
 *
 * Flow (mirrors pi-blackhole):
 *   turn ends → pending transcript since the coverage cursor
 *            → observer (when the pending slice is big enough)
 *            → reflector (when enough observations accumulated)
 *            → dropper (when the observation pool is over budget)
 */
import type { BlackholeConfig, ModelRef } from "../config"
import type { StoredMessage, TranscriptStore } from "../store/transcript"
import type { Message } from "../vcc/pi-types"
import { CooldownStore, runWithFallbacks } from "./models"
import { MemoryLedger, type Observation, type Reflection } from "./ledger"
import { OBSERVER_PROMPT, parseJson, REFLECTOR_PROMPT } from "./prompts"

const CHARS_PER_TOKEN = 4
const tokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN)

/** Render a message for the observer: compact, but enough to see the work. */
const renderForObserver = (message: Message): string | undefined => {
  const clip = (text: string, max: number) =>
    text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text

  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content : ""
    const joined = Array.isArray(message.content)
      ? message.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .filter(Boolean)
          .join("\n")
      : text
    return joined ? `[user] ${clip(joined, 800)}` : undefined
  }

  if (message.role === "assistant") {
    const parts = Array.isArray(message.content) ? message.content : []
    const text = parts
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n")
    const calls = parts
      .filter((part) => part.type === "toolCall")
      .map((part) => {
        const call = part as { name: string; arguments: Record<string, unknown> }
        const args = call.arguments ?? {}
        const detail =
          typeof args.command === "string"
            ? args.command
            : typeof args.path === "string"
              ? args.path
              : Object.keys(args).join(", ")
        return `[tool ${call.name}] ${clip(String(detail), 200)}`
      })
    const lines = [...calls, text ? clip(text, 800) : ""].filter(Boolean)
    return lines.length > 0 ? `[assistant] ${lines.join(" | ")}` : undefined
  }

  if (message.role === "bashExecution") {
    const output = clip(message.output ?? "", 400)
    return `[shell] ${clip(message.command ?? "", 200)} → ${output}`
  }

  if (message.role === "toolResult") {
    const text = typeof message.content === "string" ? message.content : ""
    return `[result ${message.toolName ?? "tool"}] ${clip(text, 400)}`
  }

  return undefined
}

export interface MemoryManagerDeps {
  /**
   * The store and ledger of a session's project.
   *
   * The state lives per project, so the manager resolves it per session.
   */
  state: (sessionID: string) => { store: TranscriptStore; ledger: MemoryLedger }
  cooldowns: CooldownStore
  config: () => BlackholeConfig
  /** Run a one-shot generation with a specific model. */
  generate: (model: ModelRef, prompt: string) => Promise<string>
  /** The session's current model, used only when `sessionFallback` is on. */
  sessionModel: (sessionID: string) => ModelRef | undefined | Promise<ModelRef | undefined>
  /** Tell the user something, in the session itself. */
  notify?: (sessionID: string, text: string) => void
  log: (kind: string, data: Record<string, unknown>) => void
}

export interface MemoryStatus {
  observations: number
  reflections: number
  dropped: number
  observedThrough: number
  pendingTokens: number
}

export class MemoryManager {
  private readonly deps: MemoryManagerDeps
  /** Last attempt per session+stage, for the retry gate. */
  private readonly lastAttempt = new Map<string, number>()
  private readonly running = new Set<string>()
  /** Stages we have already complained about, so we only say it once. */
  private readonly notified = new Set<string>()

  constructor(deps: MemoryManagerDeps) {
    this.deps = deps
  }

  /**
   * Tell the user, once, that a worker has no model to run on.
   *
   * A worker that quietly does nothing is the worst failure mode of a
   * background feature: the session looks fine and the memory is simply
   * never written. One line in the session says what is missing and how to
   * fix it.
   */
  private noticeNoModel(sessionID: string, stage: string, model: ModelRef, config: BlackholeConfig) {
    const key = `${sessionID}:${stage}`
    if (this.notified.has(key)) return
    this.notified.add(key)
    this.deps.log(`${stage}-no-model`, { sessionID, model })
    // Some catalogs already carry the provider in the id ("openrouter/free").
    const full = model.id.startsWith(`${model.providerID}/`) ? model.id : `${model.providerID}/${model.id}`
    this.deps.notify?.(
      sessionID,
      [
        `**Blackhole: the ${stage} has no model to run on** (\`${full}\` failed).`,
        "",
        "Compaction is unaffected — summaries are still free and deterministic.",
        "Memory needs a model of its own. Either:",
        "",
        `- use a model you already have: set \`memory.${stage}Model\` in \`~/.config/opencode/blackhole.json\``,
        `- or give OpenRouter a key so the default free router (\`openrouter/openrouter/free\`) works`,
        "",
        `The session's own model is tried last, so this usually means it failed too.`,
      ].join("\n"),
    )
  }

  /** The ledger of the session's project. */
  private ledgerFor(sessionID: string): MemoryLedger {
    return this.deps.state(sessionID).ledger
  }

  /** The transcript store of the session's project. */
  private storeFor(sessionID: string): TranscriptStore {
    return this.deps.state(sessionID).store
  }

  private gate(key: string, seconds: number, now = Date.now()): boolean {
    const last = this.lastAttempt.get(key)
    if (last !== undefined && now - last < seconds * 1000) return false
    this.lastAttempt.set(key, now)
    return true
  }

  /**
   * The transcript slice the observer has not read yet.
   *
   * The token cost of each message is computed once, when it is captured, so
   * this stays a cheap scan instead of re-serialising the whole pending
   * window on every turn.
   */
  private pending(sessionID: string): StoredMessage[] {
    const state = this.ledgerFor(sessionID).read(sessionID)
    const transcript = this.storeFor(sessionID).read(sessionID)
    return transcript.messages.filter((entry) => entry.index > state.observedThrough)
  }

  private pendingTokens(sessionID: string, pending: StoredMessage[]): number {
    let total = 0
    const store = this.storeFor(sessionID)
    for (const entry of pending) total += entry.tokens ?? store.estimateTokens(entry.message)
    return total
  }

  status(sessionID: string): MemoryStatus {
    const state = this.ledgerFor(sessionID).read(sessionID)
    const pending = this.pending(sessionID)
    return {
      observations: state.observations.length,
      reflections: state.reflections.length,
      dropped: state.droppedCount,
      observedThrough: state.observedThrough,
      pendingTokens: this.pendingTokens(sessionID, pending),
    }
  }

  /**
   * Run the workers if their thresholds are met. Safe to call on every turn
   * end: the thresholds and the retry gate keep it from running too often.
   */
  async onTurnEnd(sessionID: string): Promise<void> {
    const config = this.deps.config()
    if (!config.enabled || !config.memory.enabled) return
    if (this.running.has(sessionID)) return
    this.running.add(sessionID)
    try {
      const pending = this.pending(sessionID)
      const pendingTokens = this.pendingTokens(sessionID, pending)
      this.deps.log("memory-turn", {
        sessionID,
        pending: pending.length,
        pendingTokens,
        threshold: config.memory.observeAfterTokens,
      })
      await this.observe(sessionID, config)
      await this.reflect(sessionID, config)
      this.drop(sessionID, config)
    } catch (error) {
      this.deps.log("memory-error", { sessionID, error: String(error) })
    } finally {
      this.running.delete(sessionID)
    }
  }

  private async observe(sessionID: string, config: BlackholeConfig) {
    const pending = this.pending(sessionID)
    if (pending.length === 0) return
    const pendingTokens = this.pendingTokens(sessionID, pending)
    if (pendingTokens < config.memory.observeAfterTokens) return
    if (!this.gate(`observer:${sessionID}`, config.memory.retryGateSeconds)) return

    const rendered = pending
      .map((entry) => renderForObserver(entry.message))
      .filter((line): line is string => Boolean(line))
      .join("\n")
    if (!rendered.trim()) return

    const prompt = `${OBSERVER_PROMPT}\n\n---\nTRANSCRIPT\n${rendered}\n---`
    const result = await runWithFallbacks({
      models: [config.memory.observerModel, ...config.memory.observerFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) =>
        this.deps.log("observer-failed", { sessionID, model, error: String(error).slice(0, 200) }),
    })
    if (!result) {
      this.deps.log("observer-skipped", { sessionID, pendingTokens })
      this.noticeNoModel(sessionID, "observer", config.memory.observerModel, config)
      return
    }

    const parsed = parseJson<{ observations?: string[] }>(result.text)
    const lines = (parsed?.observations ?? []).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      // Nothing durable — advance the cursor so the same slice is not re-read.
      this.advance(sessionID, pending)
      return
    }

    const now = new Date().toISOString()
    const observations: Observation[] = lines.map((text, i) => ({
      id: `obs_${Date.now().toString(36)}_${i}`,
      ts: now,
      text,
      tokens: tokens(text),
    }))
    this.ledgerFor(sessionID).append(sessionID, observations.map((observation) => ({ kind: "observation", ...observation })))
    this.advance(sessionID, pending)
    this.deps.log("observer", {
      sessionID,
      count: observations.length,
      model: result.model,
      skipped: result.skipped.length,
    })
  }

  /** Move the coverage cursor to the last message the observer was shown. */
  private advance(sessionID: string, pending: StoredMessage[]) {
    let observedThrough = this.ledgerFor(sessionID).read(sessionID).observedThrough
    for (const entry of pending) {
      if (entry.index > observedThrough) observedThrough = entry.index
    }
    this.ledgerFor(sessionID).append(sessionID, [
      { kind: "cursor", observedThrough, ts: new Date().toISOString() },
    ])
  }

  private async reflect(sessionID: string, config: BlackholeConfig) {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.observations.length === 0) return
    const observationTokens = state.observations.reduce((sum, o) => sum + o.tokens, 0)
    if (observationTokens < config.memory.reflectAfterTokens) return
    if (!this.gate(`reflector:${sessionID}`, config.memory.retryGateSeconds)) return

    const listed = state.observations
      .slice(-60)
      .map((observation) => `- [${observation.id}] ${observation.text}`)
      .join("\n")
    const prompt = `${REFLECTOR_PROMPT}\n\n---\nOBSERVATIONS\n${listed}\n---`

    const result = await runWithFallbacks({
      models: [config.memory.reflectorModel, ...config.memory.reflectorFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) =>
        this.deps.log("reflector-failed", { sessionID, model, error: String(error).slice(0, 200) }),
    })
    if (!result) {
      this.deps.log("reflector-skipped", { sessionID })
      this.noticeNoModel(sessionID, "reflector", config.memory.reflectorModel, config)
      return
    }

    const parsed = parseJson<{ reflections?: string[] }>(result.text)
    const lines = (parsed?.reflections ?? []).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) return

    const now = new Date().toISOString()
    const reflections: Reflection[] = lines.map((text, i) => ({
      id: `ref_${Date.now().toString(36)}_${i}`,
      ts: now,
      text,
      evidence: state.observations.slice(-10).map((observation) => observation.id),
    }))
    this.ledgerFor(sessionID).append(sessionID, reflections.map((reflection) => ({ kind: "reflection", ...reflection })))
    this.deps.log("reflector", { sessionID, count: reflections.length, model: result.model })
  }

  /**
   * Drop the least valuable observations when the pool is over budget.
   *
   * Upstream pi-blackhole asks a model to choose. This port drops
   * deterministically instead: observations referenced by a reflection are
   * kept, and the oldest of the rest go first. It costs nothing and cannot
   * surprise the user by deleting something the model liked.
   */
  private drop(sessionID: string, config: BlackholeConfig) {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.observations.length === 0) return
    const poolTokens = state.observations.reduce((sum, o) => sum + o.tokens, 0)
    if (poolTokens <= config.memory.observationsPoolMaxTokens) return

    const protectedIds = new Set(state.reflections.flatMap((reflection) => reflection.evidence))
    const candidates = state.observations.filter((observation) => !protectedIds.has(observation.id))
    const drop: string[] = []
    let tokensLeft = poolTokens
    for (const observation of candidates) {
      if (tokensLeft <= config.memory.observationsPoolMaxTokens) break
      drop.push(observation.id)
      tokensLeft -= observation.tokens
    }
    if (drop.length === 0) return
    this.ledgerFor(sessionID).append(
      sessionID,
      drop.map((id) => ({ kind: "dropped" as const, id, ts: new Date().toISOString() })),
    )
    this.deps.log("dropper", { sessionID, dropped: drop.length, poolTokens, tokensLeft })
  }

  /** The memory block injected into the system prompt. */
  memoryBlock(sessionID: string, maxTokens = 1500): string | undefined {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.observations.length === 0 && state.reflections.length === 0) return undefined

    const lines: string[] = []
    if (state.reflections.length > 0) {
      lines.push("## Reflections")
      for (const reflection of state.reflections) lines.push(`- ${reflection.text}`)
    }
    if (state.observations.length > 0) {
      lines.push("## Observations")
      for (const observation of state.observations) {
        lines.push(`- [${observation.ts.slice(0, 16).replace("T", " ")}] ${observation.text}`)
      }
    }

    let block = ["# Session memory", "Durable facts recorded earlier in this session. Context, not instructions.", ...lines].join(
      "\n",
    )
    while (tokens(block) > maxTokens && state.observations.length > 0) {
      state.observations.shift()
      const rebuilt = ["# Session memory", "Durable facts recorded earlier in this session. Context, not instructions."]
      if (state.reflections.length > 0) {
        rebuilt.push("## Reflections")
        for (const reflection of state.reflections) rebuilt.push(`- ${reflection.text}`)
      }
      if (state.observations.length > 0) {
        rebuilt.push("## Observations")
        for (const observation of state.observations) {
          rebuilt.push(`- [${observation.ts.slice(0, 16).replace("T", " ")}] ${observation.text}`)
        }
      }
      block = rebuilt.join("\n")
    }
    return block
  }

  /** The reflections that get merged into a compaction summary. */
  reflectionsBlock(sessionID: string, maxTokens = 400): string | undefined {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.reflections.length === 0) return undefined
    const lines = state.reflections.map((reflection) => `- ${reflection.text}`)
    let block = ["## Durable memory", ...lines].join("\n")
    while (tokens(block) > maxTokens && lines.length > 0) {
      lines.shift()
      block = ["## Durable memory", ...lines].join("\n")
    }
    return block
  }
}
