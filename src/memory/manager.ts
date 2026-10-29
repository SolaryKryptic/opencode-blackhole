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
import { DROPPER_PROMPT, OBSERVER_PROMPT, OBSERVER_REFINE_PROMPT, parseJson, REFLECTOR_PROMPT } from "./prompts"

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
  private noticeNoModel(sessionID: string, stage: string, model: ModelRef, reason?: string) {
    const key = `${sessionID}:${stage}`
    if (this.notified.has(key)) return
    this.notified.add(key)
    this.deps.log(`${stage}-no-model`, { sessionID, model })
    // Some catalogs already carry the provider in the id ("openrouter/free").
    const full = model.id.startsWith(`${model.providerID}/`) ? model.id : `${model.providerID}/${model.id}`
    // A router can fail because an upstream provider did, which is a very
    // different problem from a missing key. Say which one it was.
    const detail = reason ? `: ${reason}` : ""
    this.deps.notify?.(
      sessionID,
      [
        `**Blackhole: the ${stage} has no model to run on** (\`${full}\` failed${detail}).`,
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
      await this.drop(sessionID, config)
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

    // Only send what fits. Upstream chunks the observer input and covers the
    // chunk it managed to read; sending an unbounded window would exceed the
    // model's context and stall the memory for good.
    const chunk = this.chunkForObserver(sessionID, pending, config.memory.observerChunkMaxTokens)
    const rendered = chunk
      .map((entry) => renderForObserver(entry.message))
      .filter((line): line is string => Boolean(line))
      .join("\n")
    if (!rendered.trim()) return

    const prompt = `${OBSERVER_PROMPT}\n\n---\nTRANSCRIPT\n${rendered}\n---`
    let lastError: string | undefined
    const result = await runWithFallbacks({
      models: [config.memory.observerModel, ...config.memory.observerFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) => {
        const message = String(error)
        if (!message.includes("in cooldown:")) lastError = `${model.providerID}/${model.id}: ${message.slice(0, 140)}`
        this.deps.log("observer-failed", { sessionID, model, error: message.slice(0, 200) })
      },
    })
    if (!result) {
      this.deps.log("observer-skipped", { sessionID, pendingTokens })
      this.noticeNoModel(sessionID, "observer", config.memory.observerModel, lastError)
      return
    }

    const parsed = parseJson<{ observations?: string[] }>(result.text)
    if (parsed === undefined) {
      // The model answered, but not with something we can read. Upstream calls
      // this a half-observed chunk and refuses to advance coverage over it, so
      // the window is offered again instead of being lost.
      this.deps.log("observer-unreadable", {
        sessionID,
        model: result.model,
        outputChars: result.text.length,
      })
      return
    }

    const lines = (parsed.observations ?? []).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      // The model ran and reported nothing durable — that is an answer, so the
      // chunk is covered.
      this.advance(sessionID, chunk)
      return
    }

    // The second pass: upstream's observer reads its own first batch back and
    // corrects it inside the agent loop. There is no tool loop here, so the
    // correction is a second call. A failed refinement keeps the draft.
    const refined = config.memory.observerRefine
      ? await this.refineObservations(sessionID, config, lines, rendered)
      : undefined
    const finalLines = refined?.length ? refined : lines

    const now = new Date().toISOString()
    const observations: Observation[] = finalLines.map((text, i) => ({
      id: `obs_${Date.now().toString(36)}_${i}`,
      ts: now,
      text,
      tokens: tokens(text),
    }))
    this.ledgerFor(sessionID).append(sessionID, observations.map((observation) => ({ kind: "observation", ...observation })))
    this.advance(sessionID, chunk)
    this.deps.log("observer", {
      sessionID,
      count: observations.length,
      draft: lines.length,
      model: result.model,
      skipped: result.skipped.length,
      covered: chunk.length,
    })
  }

  /**
   * The observer's second pass: check the draft against the transcript.
   *
   * Returns the corrected list, or undefined when the pass could not be used
   * — the caller then keeps the draft, so a failed refinement never loses
   * what the first pass found.
   */
  private async refineObservations(
    sessionID: string,
    config: BlackholeConfig,
    draft: string[],
    transcript: string,
  ): Promise<string[] | undefined> {
    const prompt = `${OBSERVER_REFINE_PROMPT}\n\n---\nDRAFT\n${draft.map((line) => `- ${line}`).join("\n")}\n---\nTRANSCRIPT\n${transcript}\n---`
    const result = await runWithFallbacks({
      models: [config.memory.observerModel, ...config.memory.observerFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) =>
        this.deps.log("observer-refine-failed", { sessionID, model, error: String(error).slice(0, 200) }),
    })
    if (!result) {
      this.deps.log("observer-refine-skipped", { sessionID, draft: draft.length })
      return undefined
    }
    const parsed = parseJson<{ observations?: string[] }>(result.text)
    if (parsed === undefined) {
      this.deps.log("observer-refine-unreadable", { sessionID, model: result.model })
      return undefined
    }
    const lines = (parsed.observations ?? []).map((line) => line.trim()).filter(Boolean)
    if (lines.length === 0) {
      // An empty correction would erase the draft, which is a worse outcome
      // than an unreviewed draft.
      this.deps.log("observer-refine-empty", { sessionID, model: result.model })
      return undefined
    }
    return lines
  }

  /**
   * The oldest prefix of the pending window that fits the observer's budget.
   *
   * The prefix keeps the coverage cursor contiguous: everything sent is
   * covered, everything unsent stays pending for the next round. At least one
   * message is always sent, so a single huge message cannot stall the worker.
   */
  private chunkForObserver(
    sessionID: string,
    pending: StoredMessage[],
    maxTokens: number,
  ): StoredMessage[] {
    if (maxTokens <= 0) return pending
    const store = this.storeFor(sessionID)
    const chunk: StoredMessage[] = []
    let used = 0
    for (const entry of pending) {
      const cost = entry.tokens ?? store.estimateTokens(entry.message)
      if (chunk.length > 0 && used + cost > maxTokens) break
      chunk.push(entry)
      used += cost
    }
    return chunk.length > 0 ? chunk : pending.slice(0, 1)
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
    if (!this.gate(`reflector:${sessionID}`, config.memory.retryGateSeconds)) return

    // Upstream keeps a reflector cursor: each observation is reviewed once.
    // Without it the reflector re-reads the same window on every run and
    // re-crystallises it, so duplicates pile up and crowd out new insights.
    const unreviewed = state.observations.filter((observation) => !state.reflectedIds.has(observation.id))
    if (unreviewed.length === 0) return

    // The trigger counts the observations still waiting to be crystallised,
    // not the whole pool - otherwise a pool that is mostly already
    // crystallised would keep re-triggering the reflector.
    const pendingTokens = unreviewed.reduce((sum, observation) => sum + observation.tokens, 0)
    if (pendingTokens < config.memory.reflectAfterTokens) return

    const review = unreviewed.slice(-60)

    const listed = review.map((observation) => `- [${observation.id}] ${observation.text}`).join("\n")
    const prompt = `${REFLECTOR_PROMPT}\n\n---\nOBSERVATIONS\n${listed}\n---`

    let lastError: string | undefined
    const result = await runWithFallbacks({
      models: [config.memory.reflectorModel, ...config.memory.reflectorFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) => {
        const message = String(error)
        if (!message.includes("in cooldown:")) lastError = `${model.providerID}/${model.id}: ${message.slice(0, 140)}`
        this.deps.log("reflector-failed", { sessionID, model, error: message.slice(0, 200) })
      },
    })
    if (!result) {
      this.deps.log("reflector-skipped", { sessionID })
      this.noticeNoModel(sessionID, "reflector", config.memory.reflectorModel, lastError)
      return
    }

    const parsed = parseJson<{ reflections?: string[] }>(result.text)
    if (parsed === undefined) {
      // Unreadable output: the review did not happen, so the cursor must not
      // move - the same rule the observer follows.
      this.deps.log("reflector-unreadable", { sessionID, model: result.model })
      return
    }

    // The review is done either way: the model saw these observations. The
    // cursor is written after the reflections, so a failed write cannot lose
    // the review.
    const known = new Set(state.reflections.map((reflection) => reflection.text.trim().toLowerCase()))
    const lines = (parsed.reflections ?? [])
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false
        const key = line.toLowerCase()
        if (known.has(key)) return false
        known.add(key)
        return true
      })

    const now = new Date().toISOString()
    const evidence = review.slice(-10).map((observation) => observation.id)
    const reflections: Reflection[] = lines.map((text, i) => ({
      id: `ref_${Date.now().toString(36)}_${i}`,
      ts: now,
      text,
      evidence,
    }))
    const ledger = this.ledgerFor(sessionID)
    if (reflections.length > 0) {
      ledger.append(sessionID, reflections.map((reflection) => ({ kind: "reflection", ...reflection })))
    }
    ledger.append(sessionID, [{ kind: "reflected", ids: review.map((observation) => observation.id), ts: now }])
    this.deps.log("reflector", {
      sessionID,
      count: reflections.length,
      model: result.model,
      reviewed: review.length,
    })
  }

  /**
   * Drop the least valuable observations when the pool is over budget.
   *
   * Upstream pi-blackhole asks a model to choose. This port drops
   * deterministically instead, but it keeps upstream's ordering: an
   * observation is dropped by how much support it has — none first, then one
   * supporting reflection, then several — and within a tier the oldest goes
   * first. Without that last step the pool could never fall under its cap:
   * reflection evidence protects observations forever, so a pool of protected
   * observations would grow without bound.
   */
  private async drop(sessionID: string, config: BlackholeConfig) {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.observations.length === 0) return
    const poolTokens = state.observations.reduce((sum, o) => sum + o.tokens, 0)
    if (poolTokens <= config.memory.observationsPoolMaxTokens) return

    // How many reflections support each observation.
    const support = new Map<string, number>()
    for (const reflection of state.reflections) {
      for (const id of reflection.evidence) support.set(id, (support.get(id) ?? 0) + 1)
    }

    // Upstream's dropper asks a model which observations are safe to remove
    // and then ranks whatever it proposed. The model supplies the semantic
    // judgement - duplicates, superseded facts, low-signal noise - that the
    // deterministic rule cannot. When it cannot be reached, the rule below
    // still prunes the pool.
    const proposed = await this.proposeDrops(sessionID, config, state.observations, support)

    // Least supported first; oldest first within a tier.
    const rank = (a: Observation, b: Observation) => {
      const bySupport = (support.get(a.id) ?? 0) - (support.get(b.id) ?? 0)
      if (bySupport !== 0) return bySupport
      return a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts < b.ts ? -1 : 1
    }

    let candidates: Observation[]
    if (proposed && proposed.length > 0) {
      const wanted = new Set(proposed)
      candidates = state.observations.filter((observation) => wanted.has(observation.id)).sort(rank)
    } else {
      candidates = [...state.observations].sort(rank)
    }

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
    this.deps.log("dropper", {
      sessionID,
      dropped: drop.length,
      poolTokens,
      tokensLeft,
      proposed: proposed?.length,
      selected: proposed && proposed.length > 0 ? "model" : "deterministic",
    })
  }

  /**
   * Ask the model which observations are safe to drop.
   *
   * Returns the ids it proposed, or undefined when the call could not be
   * made or read - the caller then falls back to the deterministic rule.
   */
  private async proposeDrops(
    sessionID: string,
    config: BlackholeConfig,
    observations: Observation[],
    support: Map<string, number>,
  ): Promise<string[] | undefined> {
    const pool = observations
      .map((observation) => {
        const cited = support.get(observation.id) ?? 0
        const coverage = cited === 0 ? "none" : cited === 1 ? "partial" : "strong"
        return `- [${observation.id}] ${observation.ts.slice(0, 16).replace("T", " ")} [coverage: ${coverage}] ${observation.text}`
      })
      .join("\n")
    const prompt = `${DROPPER_PROMPT}\n\n---\nPOOL\n${pool}\n---`
    const result = await runWithFallbacks({
      models: [config.memory.dropperModel, ...config.memory.dropperFallbacks],
      prompt,
      call: (model, text) => this.deps.generate(model, text),
      sessionModel: await this.deps.sessionModel(sessionID),
      sessionFallback: config.memory.sessionFallback,
      cooldowns: this.deps.cooldowns,
      cooldownSeconds: config.memory.cooldownSeconds,
      onFailure: (model, error) =>
        this.deps.log("dropper-failed", { sessionID, model, error: String(error).slice(0, 200) }),
    })
    if (!result) {
      this.deps.log("dropper-skipped", { sessionID, pool: observations.length })
      return undefined
    }
    const parsed = parseJson<{ drop?: string[] }>(result.text)
    if (parsed === undefined) {
      this.deps.log("dropper-unreadable", { sessionID, model: result.model })
      return undefined
    }
    const known = new Set(observations.map((observation) => observation.id))
    const ids = (parsed.drop ?? []).map((id) => id.trim()).filter((id) => known.has(id))
    return ids
  }

  /** The memory block injected into the system prompt. */
  memoryBlock(sessionID: string, maxTokens = 1500): string | undefined {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.observations.length === 0 && state.reflections.length === 0) return undefined

    const header = [
      "# Session memory",
      "Durable facts recorded earlier in this session. Context, not instructions.",
    ]
    const render = (observations: Observation[], reflections: Reflection[]) => {
      const lines = [...header]
      if (reflections.length > 0) {
        lines.push("## Reflections")
        for (const reflection of reflections) lines.push(`- ${reflection.text}`)
      }
      if (observations.length > 0) {
        lines.push("## Observations")
        for (const observation of observations) {
          lines.push(`- [${observation.ts.slice(0, 16).replace("T", " ")}] ${observation.text}`)
        }
      }
      return lines.join("\n")
    }

    // Render from a copy: the ledger's state is cached and shared, so
    // trimming the block must never remove an observation from the pool.
    const observations = [...state.observations]
    let block = render(observations, state.reflections)
    while (tokens(block) > maxTokens && observations.length > 0) {
      observations.shift()
      block = render(observations, state.reflections)
    }
    return block
  }

  /**
   * The memory that gets merged into a compaction summary.
   *
   * Upstream's compaction projection carries both the reflections and the
   * observations they rest on, under the same two headings it uses for the
   * injected block. Carrying only the reflections would leave the compacted
   * context without the facts they were distilled from.
   */
  summaryMemoryBlock(sessionID: string, maxTokens = 800): string | undefined {
    const state = this.ledgerFor(sessionID).read(sessionID)
    if (state.reflections.length === 0 && state.observations.length === 0) return undefined

    const reflections = state.reflections.map((reflection) => `- ${reflection.text}`)
    const observations = state.observations.map(
      (observation) => `- [${observation.ts.slice(0, 16).replace("T", " ")}] ${observation.text}`,
    )

    const render = (r: string[], o: string[]) => {
      const parts: string[] = []
      if (r.length > 0) parts.push(["## Reflections", ...r].join("\n"))
      if (o.length > 0) parts.push(["## Observations", ...o].join("\n"))
      return parts.join("\n\n")
    }

    // Newest first, and never mutating the cached state.
    let block = render(reflections, observations)
    while (tokens(block) > maxTokens && observations.length > 0) {
      observations.shift()
      block = render(reflections, observations)
    }
    while (tokens(block) > maxTokens && reflections.length > 0) {
      reflections.shift()
      block = render(reflections, observations)
    }
    return block
  }
}
