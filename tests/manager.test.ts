import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULTS, type BlackholeConfig } from "../src/config"
import { MemoryLedger } from "../src/memory/ledger"
import { MemoryManager } from "../src/memory/manager"
import { CooldownStore } from "../src/memory/models"
import { captureRequest } from "../src/store/capture"
import { TranscriptStore } from "../src/store/transcript"

const temp = () => mkdtempSync(join(tmpdir(), "blackhole-manager-"))

const user = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] })

interface Harness {
  manager: MemoryManager
  ledger: MemoryLedger
  store: TranscriptStore
  prompts: string[]
  setResponse: (text: string) => void
  /** Responses for successive calls; the last one repeats. */
  setResponses: (texts: string[]) => void
}

const harness = (config: Partial<BlackholeConfig["memory"]> = {}): Harness => {
  const dir = temp()
  const store = new TranscriptStore(join(dir, "transcripts"))
  const ledger = new MemoryLedger(join(dir, "memory"))
  const cooldowns = new CooldownStore(dir)
  const prompts: string[] = []
  let responses: string[] = ['{"observations":["a durable fact"]}']

  const settings: BlackholeConfig = {
    ...DEFAULTS,
    memory: { ...DEFAULTS.memory, observeAfterTokens: 10, reflectAfterTokens: 1_000_000, ...config },
  }

  const manager = new MemoryManager({
    state: () => ({ store, ledger }),
    cooldowns,
    config: () => settings,
    generate: async (_model, prompt) => {
      prompts.push(prompt)
      const index = Math.min(prompts.length - 1, responses.length - 1)
      return responses[index]
    },
    sessionModel: async () => undefined,
    notify: () => {},
    log: () => {},
  })

  return {
    manager,
    ledger,
    store,
    prompts,
    setResponse: (text) => (responses = [text]),
    setResponses: (texts) => (responses = texts),
  }
}

describe("observer coverage", () => {
  test("an unreadable response does not advance the cursor", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "the build is broken")])
    h.setResponse("I think the answer is probably JSON but here is prose instead")

    await h.manager.onTurnEnd("s1")

    // The window must still be pending: nothing was lost.
    expect(h.ledger.read("s1").observedThrough).toBe(0)
    expect(h.manager.status("s1").pendingTokens).toBeGreaterThan(0)
  })

  test("an empty but valid response does advance the cursor", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "the build is broken")])
    h.setResponse('{"observations":[]}')

    await h.manager.onTurnEnd("s1")

    // The model ran and said nothing was durable - that is an answer.
    expect(h.ledger.read("s1").observedThrough).toBe(1)
  })

  test("observations are recorded and the cursor advances", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "the build is broken")])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations.map((o) => o.text)).toEqual(["a durable fact"])
    expect(state.observedThrough).toBe(1)
  })
})

describe("observer chunking", () => {
  test("only what fits is sent, and only that is covered", async () => {
    const h = harness({ observerChunkMaxTokens: 20 })
    // Three messages of ~10 tokens each: only the first two fit.
    captureRequest(h.store, "s1", [
      user("m1", "x".repeat(160)),
      user("m2", "y".repeat(160)),
      user("m3", "z".repeat(160)),
    ])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    // The chunk that was sent is covered; the rest is still pending.
    expect(state.observedThrough).toBeLessThan(3)
    expect(h.manager.status("s1").pendingTokens).toBeGreaterThan(0)
  })

  test("a single huge message is still sent", async () => {
    const h = harness({ observerChunkMaxTokens: 5 })
    captureRequest(h.store, "s1", [user("m1", "x".repeat(10_000))])

    await h.manager.onTurnEnd("s1")

    // Two calls: the extraction, then the review of its draft.
    expect(h.prompts.length).toBe(2)
    expect(h.ledger.read("s1").observedThrough).toBe(1)
  })

  test("the whole window is sent when it fits", async () => {
    const h = harness({ observerChunkMaxTokens: 40_000 })
    captureRequest(h.store, "s1", [user("m1", "a"), user("m2", "b"), user("m3", "c")])

    await h.manager.onTurnEnd("s1")

    expect(h.ledger.read("s1").observedThrough).toBe(3)
  })
})

describe("memory block rendering", () => {
  test("rendering the block does not consume the observation pool", () => {
    const h = harness()
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "first fact ".repeat(200),
        tokens: 100,
      },
      {
        kind: "observation",
        id: "o2",
        ts: "2026-01-01T00:01:00.000Z",
        text: "second fact ".repeat(200),
        tokens: 100,
      },
    ])

    // A small budget forces the block to be trimmed.
    const block = h.manager.memoryBlock("s1", 60)
    expect(block).toBeDefined()

    // The pool must be untouched: the block is rendered on every request.
    expect(h.ledger.read("s1").observations).toHaveLength(2)
    expect(h.manager.memoryBlock("s1", 60)).toBe(block)
  })

  test("the trimmed block keeps the newest observations", () => {
    const h = harness()
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "old",
        ts: "2026-01-01T00:00:00.000Z",
        text: "oldest fact ".repeat(200),
        tokens: 100,
      },
      {
        kind: "observation",
        id: "new",
        ts: "2026-01-01T00:01:00.000Z",
        text: "newest fact",
        tokens: 100,
      },
    ])

    const block = h.manager.memoryBlock("s1", 40) ?? ""
    expect(block).toContain("newest fact")
    expect(block).not.toContain("oldest fact")
  })
})

describe("reflector coverage", () => {
  test("each observation is reviewed once", async () => {
    // The retry gate must be off, or the second run would never attempt a
    // reflection and the test would pass for the wrong reason.
    const h = harness({ reflectAfterTokens: 1, retryGateSeconds: 0 })
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "the parser lives in src/parser.ts",
        tokens: 10,
      },
    ])
    h.setResponse('{"reflections":["the project has a custom parser"]}')

    await h.manager.onTurnEnd("s1")
    expect(h.ledger.read("s1").reflections).toHaveLength(1)

    // A second run must not review the same observation again.
    await h.manager.onTurnEnd("s1")
    expect(h.ledger.read("s1").reflections).toHaveLength(1)
    expect(h.prompts.filter((p) => p.includes("OBSERVATIONS"))).toHaveLength(1)
  })

  test("an unreadable answer leaves the observations unreviewed", async () => {
    const h = harness({ reflectAfterTokens: 1 })
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "a fact",
        tokens: 10,
      },
    ])
    h.setResponse("prose, not json")

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.reflections).toHaveLength(0)
    expect(state.reflectedIds.has("o1")).toBe(false)
  })

  test("duplicate reflections are not stored twice", async () => {
    const h = harness({ reflectAfterTokens: 1, retryGateSeconds: 0 })
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "a fact",
        tokens: 10,
      },
    ])
    h.setResponse('{"reflections":["the same insight"]}')

    await h.manager.onTurnEnd("s1")
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o2",
        ts: "2026-01-01T00:01:00.000Z",
        text: "another fact",
        tokens: 10,
      },
    ])
    await h.manager.onTurnEnd("s1")

    const reflections = h.ledger.read("s1").reflections
    expect(reflections.filter((r) => r.text === "the same insight")).toHaveLength(1)
  })

  test("the cursor survives a ledger compaction", async () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory)
    ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "a fact",
        tokens: 10,
      },
      { kind: "reflected", ids: ["o1"], ts: "2026-01-01T00:00:00.000Z" },
    ])
    ledger.compact("s1")

    const state = new MemoryLedger(directory).read("s1")
    expect(state.reflectedIds.has("o1")).toBe(true)
  })
  test("the trigger counts unreviewed observations, not the whole pool", async () => {
    // A pool that is mostly already crystallised must not re-trigger the
    // reflector: the trigger is the pending amount.
    const h = harness({ reflectAfterTokens: 100, retryGateSeconds: 0 })
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "an old fact",
        tokens: 10,
      },
      { kind: "reflected", ids: ["o1"], ts: "2026-01-01T00:00:00.000Z" },
    ])
    h.setResponse('{"reflections":["something new"]}')

    await h.manager.onTurnEnd("s1")

    // Nothing pending, so the reflector must not run.
    expect(h.prompts.filter((p) => p.includes("OBSERVATIONS"))).toHaveLength(0)
    expect(h.ledger.read("s1").reflections).toHaveLength(0)
  })

  test("a pool under the pool cap can still trigger the reflector", async () => {
    // The trigger must sit below the pool cap, or the reflector is dead.
    const h = harness({ reflectAfterTokens: 50, observationsPoolMaxTokens: 100 })
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "a fact",
        tokens: 60,
      },
    ])
    h.setResponse('{"reflections":["a durable insight"]}')

    await h.manager.onTurnEnd("s1")

    expect(h.ledger.read("s1").reflections).toHaveLength(1)
  })
})

describe("summary memory block", () => {
  test("carries both the reflections and the observations", () => {
    const h = harness()
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "the parser lives in src/parser.ts",
        tokens: 10,
      },
      {
        kind: "reflection",
        id: "r1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "the project uses a custom parser",
        evidence: ["o1"],
      },
    ])

    const block = h.manager.summaryMemoryBlock("s1") ?? ""
    expect(block).toContain("## Reflections")
    expect(block).toContain("the project uses a custom parser")
    expect(block).toContain("## Observations")
    expect(block).toContain("the parser lives in src/parser.ts")
  })

  test("is undefined when there is nothing to carry", () => {
    const h = harness()
    expect(h.manager.summaryMemoryBlock("s1")).toBeUndefined()
  })

  test("does not consume the pool", () => {
    const h = harness()
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "o1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "fact ".repeat(400),
        tokens: 100,
      },
    ])

    h.manager.summaryMemoryBlock("s1", 40)
    expect(h.ledger.read("s1").observations).toHaveLength(1)
  })
})

describe("observation pool budget", () => {
  const seedPool = (ledger: MemoryLedger, sessionID: string) => {
    // Ten observations, all supported by a reflection - the case where the
    // pool used to be unable to fall under its cap.
    const observations = Array.from({ length: 10 }, (_, i) => ({
      kind: "observation" as const,
      id: `o${i}`,
      ts: new Date(2026, 0, 1, 0, i).toISOString(),
      text: `fact ${i} `.repeat(20),
      tokens: 100,
    }))
    ledger.append(sessionID, observations)
    ledger.append(sessionID, [
      {
        kind: "reflection",
        id: "r1",
        ts: "2026-01-01T00:00:00.000Z",
        text: "a reflection",
        evidence: observations.map((o) => o.id),
      },
    ])
  }

  test("the pool falls under its cap even when every observation is supported", async () => {
    const h = harness({ observationsPoolMaxTokens: 500 })
    seedPool(h.ledger, "s1")

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    const poolTokens = state.observations.reduce((sum, o) => sum + o.tokens, 0)
    expect(poolTokens).toBeLessThanOrEqual(500)
    // Some were dropped, so the pool can shrink.
    expect(state.observations.length).toBeLessThan(10)
  })

  test("unsupported observations go before supported ones", async () => {
    // 11 observations of 100 tokens = 1100; a cap of 1000 means exactly one
    // has to go - and it must be the unsupported one.
    const h = harness({ observationsPoolMaxTokens: 1_000 })
    seedPool(h.ledger, "s1")
    // One observation with no support at all.
    h.ledger.append("s1", [
      {
        kind: "observation",
        id: "loose",
        ts: "2026-01-02T00:00:00.000Z",
        text: "loose fact ".repeat(20),
        tokens: 100,
      },
    ])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    // The unsupported one is dropped first.
    expect(state.observations.some((o) => o.id === "loose")).toBe(false)
    expect(state.observations.some((o) => o.id === "o0")).toBe(true)
  })

  test("a pool under its cap is left alone", async () => {
    const h = harness({ observationsPoolMaxTokens: 10_000 })
    seedPool(h.ledger, "s1")

    await h.manager.onTurnEnd("s1")

    expect(h.ledger.read("s1").observations).toHaveLength(10)
  })
})

describe("dropper proposal", () => {
  const seed = (ledger: MemoryLedger, sessionID: string) => {
    const observations = Array.from({ length: 6 }, (_, i) => ({
      kind: "observation" as const,
      id: `o${i}`,
      ts: new Date(2026, 0, 1, 0, i).toISOString(),
      text: `fact ${i} `.repeat(20),
      tokens: 100,
    }))
    ledger.append(sessionID, observations)
  }

  test("the model's proposals decide what is dropped", async () => {
    const h = harness({ observationsPoolMaxTokens: 400 })
    seed(h.ledger, "s1")
    // The model names o4 and o5; the pool needs two gone to reach the cap.
    h.setResponse('{"drop":["o4","o5"]}')

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations.some((o) => o.id === "o4")).toBe(false)
    expect(state.observations.some((o) => o.id === "o5")).toBe(false)
    // The ones the model did not name are kept.
    expect(state.observations.some((o) => o.id === "o0")).toBe(true)
  })

  test("a failed proposal falls back to the deterministic rule", async () => {
    const h = harness({ observationsPoolMaxTokens: 400 })
    seed(h.ledger, "s1")
    h.setResponse("not json")

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    const poolTokens = state.observations.reduce((sum, o) => sum + o.tokens, 0)
    expect(poolTokens).toBeLessThanOrEqual(400)
  })

  test("an unknown id in the proposal is ignored", async () => {
    const h = harness({ observationsPoolMaxTokens: 400 })
    seed(h.ledger, "s1")
    h.setResponse('{"drop":["not_a_real_id","o5"]}')

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations.some((o) => o.id === "o5")).toBe(false)
    expect(state.observations.length).toBe(5)
  })

  test("a pool under its cap never calls the model", async () => {
    const h = harness({ observationsPoolMaxTokens: 10_000 })
    seed(h.ledger, "s1")

    await h.manager.onTurnEnd("s1")

    // Only the observer ran; the dropper never asked anything.
    expect(h.prompts.some((prompt) => prompt.includes("POOL"))).toBe(false)
    expect(h.ledger.read("s1").observations).toHaveLength(6)
  })
})

describe("observer second pass", () => {
  test("the reviewed list replaces the draft", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "we chose Postgres over SQLite")])
    h.setResponses([
      '{"observations":["the user chose a database"]}',
      '{"observations":["the user chose Postgres over SQLite because of concurrent writes"]}',
    ])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations).toHaveLength(1)
    expect(state.observations[0].text).toContain("concurrent writes")
  })

  test("a failed review keeps the draft", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "we chose Postgres over SQLite")])
    h.setResponses(['{"observations":["the draft fact"]}', "not json at all"])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations).toHaveLength(1)
    expect(state.observations[0].text).toBe("the draft fact")
    // The chunk was still observed, so it is covered.
    expect(state.observedThrough).toBe(1)
  })

  test("an empty review keeps the draft", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "we chose Postgres over SQLite")])
    h.setResponses(['{"observations":["the draft fact"]}', '{"observations":[]}'])

    await h.manager.onTurnEnd("s1")

    const state = h.ledger.read("s1")
    expect(state.observations).toHaveLength(1)
    expect(state.observations[0].text).toBe("the draft fact")
  })

  test("the review can be turned off", async () => {
    const h = harness({ observerRefine: false })
    captureRequest(h.store, "s1", [user("m1", "we chose Postgres over SQLite")])

    await h.manager.onTurnEnd("s1")

    expect(h.prompts.length).toBe(1)
    expect(h.ledger.read("s1").observations).toHaveLength(1)
  })

  test("the review is asked for the draft and the transcript", async () => {
    const h = harness()
    captureRequest(h.store, "s1", [user("m1", "we chose Postgres over SQLite")])
    h.setResponses(['{"observations":["a draft fact"]}', '{"observations":["a draft fact"]}'])

    await h.manager.onTurnEnd("s1")

    expect(h.prompts.length).toBe(2)
    expect(h.prompts[1]).toContain("a draft fact")
    expect(h.prompts[1]).toContain("we chose Postgres over SQLite")
  })
})
