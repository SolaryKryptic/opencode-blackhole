import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MemoryLedger } from "../src/memory/ledger"

const temp = () => mkdtempSync(join(tmpdir(), "blackhole-ledger-"))

const observation = (id: string) => ({
  kind: "observation" as const,
  id,
  ts: "2026-01-01T00:00:00Z",
  text: `fact ${id}`,
  tokens: 2,
})

describe("MemoryLedger", () => {
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
    ledger.append("s1", [observation("o1"), { kind: "dropped", id: "o1", ts: "t" }])

    const state = ledger.read("s1")
    expect(state.observations).toHaveLength(0)
    expect(state.dropped).toHaveLength(1)
    expect(state.droppedCount).toBe(1)
  })

  test("compacts a large file but keeps the live memory", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory, { maxFileBytes: 4_096 })

    for (let i = 0; i < 200; i++) {
      ledger.append("s1", [observation(`o${i}`), { kind: "dropped", id: `o${i}`, ts: "t" }])
    }
    ledger.append("s1", [observation("keep"), { kind: "cursor", observedThrough: 42, ts: "t" }])

    const path = join(directory, "s1.jsonl")
    const size = statSync(path).size
    expect(size).toBeLessThan(4_096)

    const state = new MemoryLedger(directory).read("s1")
    expect(state.observations.map((o) => o.id)).toContain("keep")
    expect(state.observedThrough).toBe(42)
    // The dropped count survives the compaction.
    expect(state.droppedCount).toBe(200)
  })

  test("compaction keeps the file smaller than the live content", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory, { maxFileBytes: 4_096 })
    for (let i = 0; i < 300; i++) {
      ledger.append("s1", [observation(`o${i}`), { kind: "dropped", id: `o${i}`, ts: "t" }])
    }
    const path = join(directory, "s1.jsonl")
    expect(statSync(path).size).toBeLessThan(4_096)
  })

  test("evicts the least recently used ledger from memory", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory, { maxCachedSessions: 2 })
    ledger.append("s1", [observation("o1")])
    ledger.append("s2", [observation("o2")])
    const first = ledger.read("s1")
    const second = ledger.read("s2")

    // Touch s1 so s2 becomes the oldest, then overflow the cache.
    ledger.read("s1")
    ledger.append("s3", [observation("o3")])

    expect(ledger.read("s1")).toBe(first)
    expect(ledger.read("s2")).not.toBe(second)
  })

  test("sweeps ledgers that have not been touched for a while", () => {
    const directory = join(temp(), "memory")
    const ledger = new MemoryLedger(directory)
    ledger.append("s1", [observation("o1")])

    const path = join(directory, "s1.jsonl")
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000)
    utimesSync(path, old, old)

    expect(ledger.sweep(90 * 24 * 60 * 60 * 1000)).toBe(1)
    expect(() => statSync(path)).toThrow()
  })
})
