/**
 * Configuration for opencode-blackhole.
 *
 * Merge order (last wins):
 *   defaults → global (~/.config/opencode/blackhole.json)
 *            → project (<project>/.opencode/blackhole.json)
 *            → plugin options (opencode.json → plugins[].options)
 *
 * The project file is read on every compaction so edits apply without a
 * server restart.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface ModelRef {
  providerID: string
  id: string
}

/** The free OpenRouter router — the default worker model. */
export const DEFAULT_WORKER_MODEL: ModelRef = { providerID: "openrouter", id: "openrouter/free" }

export interface BlackholeConfig {
  /** Master switch. When false the plugin does nothing at all. */
  enabled: boolean
  /** Deterministic compaction: replace the model's own summarizer. */
  compaction: {
    enabled: boolean
    /** Keep the vcc brief transcript (the ranked tail of the conversation). */
    brief: boolean
    /** Token budget for the brief transcript. */
    briefTokens: number
    /** Hard cap for the whole summary. */
    maxSummaryTokens: number
    /** Extra instruction appended to the summary, e.g. project conventions. */
    extraNote: string
  }
  memory: {
    enabled: boolean
    observerModel: ModelRef
    reflectorModel: ModelRef
    dropperModel: ModelRef
    /** Extra models to try when the primary worker model fails. */
    observerFallbacks: ModelRef[]
    reflectorFallbacks: ModelRef[]
    dropperFallbacks: ModelRef[]
    /** Allow a worker to fall back to the session's model. Off by default so
     *  background work never silently bills the main model. */
    sessionFallback: boolean
    /** Run the observer once the session has grown by this many tokens. */
    observeAfterTokens: number
    /**
     * Run the reflector once this many observation tokens are pending.
     *
     * Upstream uses 25,000, but its observation cap bounds the *projection*
     * rather than the store. This port's cap is a hard delete, so the trigger
     * has to sit below it or the reflector could never fire.
     */
    reflectAfterTokens: number
    /**
     * The most the observer is shown in one round.
     *
     * Upstream pi-blackhole chunks the observer input at the same limit: a
     * window that does not fit would overflow the model's context and stall
     * the memory. The chunk that is sent is covered; the rest stays pending.
     */
    observerChunkMaxTokens: number
    /** Drop low-value observations above this pool size. */
    observationsPoolMaxTokens: number
    /** Minimum seconds between two attempts of the same worker. */
    retryGateSeconds: number
    /** How long a failed model stays in cooldown. Upstream cools for an hour. */
    cooldownSeconds: number
  }
  recall: {
    enabled: boolean
    /**
     * Maximum characters in a single recall response.
     *
     * Bounds search pages, expanded entries and related observations, so one
     * huge stored message cannot flood the context. The budget is shared
     * across the entries of a response, and each entry's lines share their
     * slice of it. 0 disables the cap.
     */
    responseMaxChars: number
  }
  /** How long the plugin keeps its own state on disk. */
  retention: {
    /** Days to keep a session transcript. 0 keeps them forever. */
    transcriptDays: number
    /** Days to keep a session's memory ledger. 0 keeps them forever. */
    memoryDays: number
    /** Days to keep the trace log. 0 keeps it forever. */
    logDays: number
  }
  /** Runtime limits that keep a long-lived server healthy. */
  limits: {
    /** How many parsed sessions stay in memory at once. */
    maxCachedSessions: number
    /** Hard cap for the content of a single stored message. */
    maxMessageChars: number
    /** Compact a ledger file once it grows past this size. */
    maxLedgerBytes: number
  }
  /** "debug" writes a JSONL trace next to the plugin state. */
  logLevel: "off" | "info" | "debug"
}

export const DEFAULTS: BlackholeConfig = {
  enabled: true,
  compaction: {
    enabled: true,
    brief: true,
    briefTokens: 2_000,
    maxSummaryTokens: 4_000,
    extraNote: "",
  },
  memory: {
    enabled: true,
    observerModel: DEFAULT_WORKER_MODEL,
    reflectorModel: DEFAULT_WORKER_MODEL,
    dropperModel: DEFAULT_WORKER_MODEL,
    observerFallbacks: [],
    reflectorFallbacks: [],
    dropperFallbacks: [],
    /**
     * Allow a worker to fall back to the session's model when its own model
     * chain is exhausted. Upstream pi-blackhole defaults this to true, so
     * memory works out of the box; set it to false to guarantee that
     * background work never bills the session's model.
     */
    sessionFallback: true,
    observeAfterTokens: 15_000,
    reflectAfterTokens: 15_000,
    observerChunkMaxTokens: 40_000,
    observationsPoolMaxTokens: 20_000,
    retryGateSeconds: 30,
    cooldownSeconds: 3_600,
  },
  recall: { enabled: true, responseMaxChars: 48_000 },
  retention: {
    transcriptDays: 7,
    memoryDays: 90,
    logDays: 7,
  },
  limits: {
    maxCachedSessions: 8,
    maxMessageChars: 262_144,
    maxLedgerBytes: 65_536,
  },
  logLevel: "off",
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    if (!existsSync(path)) return undefined
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const asModelRef = (value: unknown): ModelRef | undefined => {
  if (!isObject(value)) return undefined
  const providerID = value.providerID ?? value.provider
  const id = value.id ?? value.model
  if (typeof providerID === "string" && typeof id === "string") return { providerID, id }
  return undefined
}

const asModelRefs = (value: unknown): ModelRef[] =>
  Array.isArray(value) ? value.map(asModelRef).filter((m): m is ModelRef => m !== undefined) : []

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback

const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback

const merge = (base: BlackholeConfig, patch: Record<string, unknown>): BlackholeConfig => {
  const compaction = isObject(patch.compaction) ? patch.compaction : {}
  const memory = isObject(patch.memory) ? patch.memory : {}
  const recall = isObject(patch.recall) ? patch.recall : {}
  const retention = isObject(patch.retention) ? patch.retention : {}
  const limits = isObject(patch.limits) ? patch.limits : {}

  return {
    enabled: asBoolean(patch.enabled, base.enabled),
    compaction: {
      enabled: asBoolean(compaction.enabled, base.compaction.enabled),
      brief: asBoolean(compaction.brief, base.compaction.brief),
      briefTokens: asNumber(compaction.briefTokens, base.compaction.briefTokens),
      maxSummaryTokens: asNumber(compaction.maxSummaryTokens, base.compaction.maxSummaryTokens),
      extraNote: asString(compaction.extraNote, base.compaction.extraNote),
    },
    memory: {
      enabled: asBoolean(memory.enabled, base.memory.enabled),
      observerModel: asModelRef(memory.observerModel) ?? base.memory.observerModel,
      reflectorModel: asModelRef(memory.reflectorModel) ?? base.memory.reflectorModel,
      dropperModel: asModelRef(memory.dropperModel) ?? base.memory.dropperModel,
      observerFallbacks: memory.observerFallbacks
        ? asModelRefs(memory.observerFallbacks)
        : base.memory.observerFallbacks,
      reflectorFallbacks: memory.reflectorFallbacks
        ? asModelRefs(memory.reflectorFallbacks)
        : base.memory.reflectorFallbacks,
      dropperFallbacks: memory.dropperFallbacks
        ? asModelRefs(memory.dropperFallbacks)
        : base.memory.dropperFallbacks,
      sessionFallback: asBoolean(memory.sessionFallback, base.memory.sessionFallback),
      observeAfterTokens: asNumber(memory.observeAfterTokens, base.memory.observeAfterTokens),
      reflectAfterTokens: asNumber(memory.reflectAfterTokens, base.memory.reflectAfterTokens),
      observerChunkMaxTokens: asNumber(memory.observerChunkMaxTokens, base.memory.observerChunkMaxTokens),
      observationsPoolMaxTokens: asNumber(
        memory.observationsPoolMaxTokens,
        base.memory.observationsPoolMaxTokens,
      ),
      retryGateSeconds: asNumber(memory.retryGateSeconds, base.memory.retryGateSeconds),
      cooldownSeconds: asNumber(memory.cooldownSeconds, base.memory.cooldownSeconds),
    },
    recall: {
      enabled: asBoolean(recall.enabled, base.recall.enabled),
      responseMaxChars: asNumber(recall.responseMaxChars, base.recall.responseMaxChars),
    },
    retention: {
      transcriptDays: asNumber(retention.transcriptDays, base.retention.transcriptDays),
      memoryDays: asNumber(retention.memoryDays, base.retention.memoryDays),
      logDays: asNumber(retention.logDays, base.retention.logDays),
    },
    limits: {
      maxCachedSessions: asNumber(limits.maxCachedSessions, base.limits.maxCachedSessions),
      maxMessageChars: asNumber(limits.maxMessageChars, base.limits.maxMessageChars),
      maxLedgerBytes: asNumber(limits.maxLedgerBytes, base.limits.maxLedgerBytes),
    },
    logLevel: (["off", "info", "debug"] as const).includes(patch.logLevel as any)
      ? (patch.logLevel as BlackholeConfig["logLevel"])
      : base.logLevel,
  }
}

const globalConfigPath = () => join(homedir(), ".config", "opencode", "blackhole.json")

export interface LoadOptions {
  /** Project directory (the plugin's location directory). */
  directory: string
  /** Plugin options from opencode.json. */
  options?: unknown
}

export const loadConfig = ({ directory, options }: LoadOptions): BlackholeConfig => {
  let config = DEFAULTS
  const global = readJson(globalConfigPath())
  if (global) config = merge(config, global)
  const project = readJson(join(directory, ".opencode", "blackhole.json"))
  if (project) config = merge(config, project)
  if (isObject(options)) config = merge(config, options)
  return config
}
