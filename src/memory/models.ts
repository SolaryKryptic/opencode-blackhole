/**
 * Worker model selection: fallback chains, per-model cooldowns and a retry
 * gate.
 *
 * The rules mirror pi-blackhole:
 *  - each worker has its own chain: primary → fallbacks → (session model, only
 *    when `sessionFallback` is on);
 *  - a model that fails gets a cooldown and is skipped on later attempts;
 *  - a transient failure (rate limit, timeout, an upstream error under a
 *    router) is retried once and cooled down briefly, because it says nothing
 *    about the model a minute later;
 *  - a failed stage is skipped, never escalated to a paid model by accident;
 *  - the coverage cursor never advances past what a worker actually saw.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ModelRef } from "../config"

export interface CooldownEntry {
  until: number
  reason: string
}

export class CooldownStore {
  private readonly path: string
  private state: Record<string, CooldownEntry> = {}

  constructor(dir: string) {
    this.path = join(dir, "cooldowns.json")
    try {
      if (existsSync(this.path)) this.state = JSON.parse(readFileSync(this.path, "utf8"))
    } catch {
      this.state = {}
    }
  }

  static key(model: ModelRef): string {
    return `${model.providerID}/${model.id}`
  }

  active(model: ModelRef, now = Date.now()): CooldownEntry | undefined {
    const entry = this.state[CooldownStore.key(model)]
    if (!entry) return undefined
    if (entry.until <= now) {
      delete this.state[CooldownStore.key(model)]
      return undefined
    }
    return entry
  }

  cool(model: ModelRef, reason: string, seconds: number, now = Date.now()) {
    this.state[CooldownStore.key(model)] = { until: now + seconds * 1000, reason }
    this.persist()
  }

  private persist() {
    try {
      writeFileSync(this.path, JSON.stringify(this.state, null, 2))
    } catch {
      // Cooldowns are an optimization; failing to persist them is not fatal.
    }
  }
}

/** Errors worth retrying on another model rather than skipping the stage. */
const RETRYABLE =
  /rate.?limit|429|too many requests|timeout|timed out|overload|503|502|500|bad gateway|service unavailable|fetch failed|econn|network|stream (?:error|closed)|aborted|finish_reason:?\s*error|provider reported an error/i

/**
 * How long a transient failure is cooled down for.
 *
 * A rate limit, a timeout or an upstream error under a router says nothing
 * about whether the model will work in a minute. Cooling it for the full hour
 * turns one bad request into an hour of missing memory.
 */
export const TRANSIENT_COOLDOWN_SECONDS = 180

/**
 * A model the catalog does not know.
 *
 * Cooling such a model down would only clutter the store: it will still be
 * missing next time. Upstream skips it for the same reason.
 */
const UNKNOWN_MODEL = /model .*(not found|does not exist|not available|unavailable|unknown)|no such model|model_not_found|modelselectionerror/i

export const isRetryable = (error: unknown): boolean => {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error)
  return RETRYABLE.test(text)
}

/** True when the model itself is unknown to the provider catalog. */
export const isUnknownModel = (error: unknown): boolean => {
  const text = error instanceof Error ? `${error.message} ${error.stack ?? ""}` : String(error)
  return UNKNOWN_MODEL.test(text)
}

export interface RunResult {
  text: string
  model: ModelRef
  /** Models that were tried and failed before this one. */
  skipped: ModelRef[]
}

export interface RunOptions {
  models: ModelRef[]
  prompt: string
  /** Called for each model attempt. */
  call: (model: ModelRef, prompt: string) => Promise<string>
  /** The session's model, used only when `sessionFallback` is on. */
  sessionModel?: ModelRef
  sessionFallback?: boolean
  cooldowns: CooldownStore
  /** How long a failed model stays in cooldown. */
  cooldownSeconds: number
  onAttempt?: (model: ModelRef) => void
  onFailure?: (model: ModelRef, error: unknown, retryable: boolean) => void
}

/**
 * Try each model in the chain until one answers.
 *
 * A model in cooldown is skipped. Every failure moves on to the next
 * candidate - including a deterministic one (bad credentials, an unknown
 * model, a rejected payload), which upstream also cools down rather than
 * burning every cycle on a model that cannot work. That is what makes the
 * session model a real last resort: a dead worker credential falls through to
 * it instead of ending the stage.
 */
export const runWithFallbacks = async (options: RunOptions): Promise<RunResult | undefined> => {
  const chain = [...options.models]
  if (options.sessionFallback && options.sessionModel) chain.push(options.sessionModel)

  const skipped: ModelRef[] = []
  for (const model of chain) {
    const cooldown = options.cooldowns.active(model)
    if (cooldown) {
      skipped.push(model)
      options.onFailure?.(model, new Error(`in cooldown: ${cooldown.reason}`), true)
      continue
    }
    // One immediate retry for a transient failure. A router such as
    // openrouter/free picks a provider per request, so the second call often
    // lands somewhere else - cheaper than losing the whole stage.
    for (let attempt = 0; ; attempt++) {
      options.onAttempt?.(model)
      try {
        const text = await options.call(model, options.prompt)
        return { text, model, skipped }
      } catch (error) {
        const retryable = isRetryable(error)
        options.onFailure?.(model, error, retryable)
        if (isUnknownModel(error)) {
          // Not in the catalog: skip it, but do not cool it down - it will
          // still be missing next time.
          skipped.push(model)
          break
        }
        if (retryable && attempt === 0) continue
        // Deterministic failures cool for the full window; transient ones
        // come back quickly instead of costing an hour of memory.
        options.cooldowns.cool(
          model,
          String(error).slice(0, 200),
          retryable ? Math.min(options.cooldownSeconds, TRANSIENT_COOLDOWN_SECONDS) : options.cooldownSeconds,
        )
        skipped.push(model)
        break
      }
    }
  }
  return undefined
}
