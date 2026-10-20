import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CooldownStore, isRetryable, runWithFallbacks } from "../src/memory/models"
import { parseJson } from "../src/memory/prompts"

const model = (id: string) => ({ providerID: "openrouter", id })

/** A fresh cooldown store per test: cooldowns persist on disk by design. */
const freshCooldowns = () => new CooldownStore(mkdtempSync(join(tmpdir(), "blackhole-cooldown-")))

describe("runWithFallbacks", () => {
  test("uses the first model that answers", async () => {
    const result = await runWithFallbacks({
      models: [model("a"), model("b")],
      prompt: "p",
      call: async (m) => `answer from ${m.id}`,
      cooldowns: freshCooldowns(),
      cooldownSeconds: 60,
    })
    expect(result?.text).toBe("answer from a")
    expect(result?.model.id).toBe("a")
  })

  test("falls back on a retryable error", async () => {
    const result = await runWithFallbacks({
      models: [model("a"), model("b")],
      prompt: "p",
      call: async (m) => {
        if (m.id === "a") throw new Error("429 rate limit exceeded")
        return "ok"
      },
      cooldowns: freshCooldowns(),
      cooldownSeconds: 60,
    })
    expect(result?.text).toBe("ok")
    expect(result?.model.id).toBe("b")
    expect(result?.skipped).toContainEqual(model("a"))
  })

  test("skips a model in cooldown", async () => {
    const store = freshCooldowns()
    store.cool(model("a"), "rate limit", 600)
    const result = await runWithFallbacks({
      models: [model("a"), model("b")],
      prompt: "p",
      call: async (m) => `answer from ${m.id}`,
      cooldowns: store,
      cooldownSeconds: 60,
    })
    expect(result?.model.id).toBe("b")
  })

  test("does not fall back to the session model unless allowed", async () => {
    const result = await runWithFallbacks({
      models: [model("a")],
      prompt: "p",
      call: async () => {
        throw new Error("500 internal server error")
      },
      sessionModel: model("session"),
      sessionFallback: false,
      cooldowns: freshCooldowns(),
      cooldownSeconds: 60,
    })
    expect(result).toBeUndefined()
  })

  test("uses the session model when the fallback is allowed", async () => {
    const result = await runWithFallbacks({
      models: [model("a")],
      prompt: "p",
      call: async (m) => {
        if (m.id === "a") throw new Error("503 overloaded")
        return "session answer"
      },
      sessionModel: model("session"),
      sessionFallback: true,
      cooldowns: freshCooldowns(),
      cooldownSeconds: 60,
    })
    expect(result?.text).toBe("session answer")
  })

  test("a bad credential falls through to the next candidate", async () => {
    // A deterministic failure (bad key, unknown model, rejected payload) must
    // still engage the fallback chain: upstream cools the broken model down
    // and moves on, so the session model remains a usable last resort.
    const result = await runWithFallbacks({
      models: [model("a")],
      prompt: "p",
      call: async (m) => {
        if (m.id === "a") throw new Error("401 Unauthorized: invalid api key")
        return "session answer"
      },
      sessionModel: model("session"),
      sessionFallback: true,
      cooldowns: freshCooldowns(),
      cooldownSeconds: 60,
    })
    expect(result?.text).toBe("session answer")
    expect(result?.model.id).toBe("session")
    expect(result?.skipped).toContainEqual(model("a"))
  })

  test("a broken credential is cooled down so the cycle is not burned again", async () => {
    const cooldowns = freshCooldowns()
    await runWithFallbacks({
      models: [model("a")],
      prompt: "p",
      call: async () => {
        throw new Error("unauthorized")
      },
      sessionModel: model("session"),
      sessionFallback: true,
      cooldowns,
      cooldownSeconds: 60,
    })
    expect(cooldowns.active(model("a"))).toBeDefined()
  })

  test("an unknown model is skipped without a cooldown", async () => {
    const cooldowns = freshCooldowns()
    const result = await runWithFallbacks({
      models: [model("a")],
      prompt: "p",
      call: async (m) => {
        if (m.id === "a") throw new Error("Model not found: nope/none")
        return "session answer"
      },
      sessionModel: model("session"),
      sessionFallback: true,
      cooldowns,
      cooldownSeconds: 60,
    })
    expect(result?.model.id).toBe("session")
    // It will still be missing next time, so cooling it down would only
    // clutter the store.
    expect(cooldowns.active(model("a"))).toBeUndefined()
  })
})

describe("isRetryable", () => {
  test("recognizes rate limits and timeouts", () => {
    expect(isRetryable(new Error("429 too many requests"))).toBe(true)
    expect(isRetryable(new Error("Request timed out"))).toBe(true)
    expect(isRetryable(new Error("fetch failed"))).toBe(true)
  })

  test("does not treat a bad model id as retryable", () => {
    expect(isRetryable(new Error("model not found"))).toBe(false)
  })
})

describe("parseJson", () => {
  test("parses a plain object", () => {
    expect(parseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  test("parses a fenced block", () => {
    expect(parseJson<{ a: number }>('```json\n{"a":2}\n```')).toEqual({ a: 2 })
  })

  test("parses an object wrapped in prose", () => {
    expect(parseJson<{ a: number }>('Here you go: {"a":3} — done')).toEqual({ a: 3 })
  })

  test("returns undefined for junk", () => {
    expect(parseJson("not json at all")).toBeUndefined()
  })
})
