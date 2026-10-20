import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULTS, loadConfig } from "../src/config"
import { MemoryLedger } from "../src/memory/ledger"
import { TranscriptStore } from "../src/store/transcript"
import { captureRequest } from "../src/store/capture"

const temp = () => mkdtempSync(join(tmpdir(), "blackhole-test-"))

describe("loadConfig", () => {
  test("returns the defaults when nothing is configured", () => {
    const config = loadConfig({ directory: temp() })
    expect(config.enabled).toBe(DEFAULTS.enabled)
    expect(config.memory.observerModel).toEqual({ providerID: "openrouter", id: "openrouter/free" })
    // Upstream pi-blackhole falls back to the session's model by default.
    expect(config.memory.sessionFallback).toBe(true)
    expect(config.memory.observeAfterTokens).toBe(15_000)
    expect(config.memory.reflectAfterTokens).toBe(25_000)
  })

  test("plugin options win over the project file", () => {
    const directory = temp()
    const config = loadConfig({
      directory,
      options: { memory: { observerModel: { providerID: "p", id: "m" } } },
    })
    expect(config.memory.observerModel).toEqual({ providerID: "p", id: "m" })
  })

  test("ignores malformed values", () => {
    const config = loadConfig({ directory: temp(), options: { memory: { observeAfterTokens: "nope" } } })
    expect(config.memory.observeAfterTokens).toBe(DEFAULTS.memory.observeAfterTokens)
  })
})

describe("transcript store", () => {
  test("assigns session-global indices and dedupes", () => {
    const directory = temp()
    const store = new TranscriptStore(join(directory, "transcripts"))
    const messages = [
      { id: "m1", role: "user", content: [{ type: "text", text: "a" }] },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "b" }] },
    ]

    expect(captureRequest(store, "s1", messages)).toBe(2)
    expect(captureRequest(store, "s1", messages)).toBe(0)

    const transcript = store.read("s1")
    expect(transcript.messages.map((entry) => entry.index)).toEqual([1, 2])
    expect(transcript.indexById.get("m2")).toBe(2)
  })

  test("survives a restart", () => {
    const directory = join(temp(), "transcripts")
    const store = new TranscriptStore(directory)
    captureRequest(store, "s1", [{ id: "m1", role: "user", content: [{ type: "text", text: "a" }] }])

    const reopened = new TranscriptStore(directory)
    expect(reopened.read("s1").messages).toHaveLength(1)
  })
})

describe("memory ledger", () => {
  test("round-trips observations, reflections and the cursor", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory)
    ledger.append("s1", [
      { kind: "observation", id: "o1", ts: "2026-01-01T00:00:00Z", text: "fact", tokens: 2 },
      { kind: "reflection", id: "r1", ts: "2026-01-01T00:00:00Z", text: "insight", evidence: ["o1"] },
      { kind: "cursor", observedThrough: 7, ts: "2026-01-01T00:00:00Z" },
    ])

    const state = new MemoryLedger(directory).read("s1")
    expect(state.observations).toHaveLength(1)
    expect(state.reflections).toHaveLength(1)
    expect(state.observedThrough).toBe(7)
  })

  test("moves dropped observations out of the active pool", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory)
    ledger.append("s1", [
      { kind: "observation", id: "o1", ts: "t", text: "fact", tokens: 2 },
      { kind: "dropped", id: "o1", ts: "t" },
    ])

    const state = ledger.read("s1")
    expect(state.observations).toHaveLength(0)
    expect(state.dropped).toHaveLength(1)
  })
})
