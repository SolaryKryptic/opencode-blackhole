import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TranscriptStore } from "../src/store/transcript"
import { captureRequest } from "../src/store/capture"

const temp = () => mkdtempSync(join(tmpdir(), "blackhole-store-"))

const user = (id: string, text: string) => ({ id, role: "user", content: [{ type: "text", text }] })
const assistant = (id: string, text: string) => ({ id, role: "assistant", content: [{ type: "text", text }] })
const toolCall = (id: string, callId: string, name: string, input: unknown) => ({
  id,
  role: "assistant",
  content: [{ type: "tool-call", id: callId, name, input }],
})
const toolResult = (id: string, callId: string, name: string, output: unknown) => ({
  id,
  role: "tool",
  content: [{ type: "tool-result", toolCallId: callId, name, output }],
})

describe("captureRequest", () => {
  test("stores only the messages it has not seen", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    const messages = [user("m1", "hello"), assistant("m2", "hi")]

    expect(captureRequest(store, "s1", messages)).toBe(2)
    expect(captureRequest(store, "s1", messages)).toBe(0)
    expect(store.read("s1").messages).toHaveLength(2)
  })

  test("keeps the session-global index stable across requests", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    captureRequest(store, "s1", [user("m1", "a")])
    captureRequest(store, "s1", [user("m1", "a"), assistant("m2", "b")])

    const transcript = store.read("s1")
    expect(transcript.messages.map((entry) => entry.index)).toEqual([1, 2])
    expect(transcript.indexById.get("m2")).toBe(2)
  })

  test("pairs a tool result with a call captured in an earlier request", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    captureRequest(store, "s1", [toolCall("m1", "call_1", "read", { path: "a.ts" })])

    // A later request carries the result but not the call.
    captureRequest(store, "s1", [toolResult("m2", "call_1", "read", { content: "file body" })])

    const messages = store.read("s1").messages.map((entry) => entry.message)
    const result = messages.find((message) => message.role === "toolResult") as any
    expect(result).toBeDefined()
    expect(result.toolName).toBe("read")
    expect(result.content).toBe("file body")
  })

  test("never stores a compaction checkpoint", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    const checkpoint = user("m1", "<conversation-checkpoint>\n<summary>old</summary>\n</conversation-checkpoint>")
    captureRequest(store, "s1", [checkpoint])
    expect(store.read("s1").messages).toHaveLength(0)

    // The checkpoint comes back with every request; it must stay ignored.
    captureRequest(store, "s1", [checkpoint, user("m2", "next")])
    expect(store.read("s1").messages).toHaveLength(1)
  })

  test("records the token cost of every message once", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    captureRequest(store, "s1", [user("m1", "hello world")])
    const entry = store.read("s1").messages[0]
    expect(entry.tokens).toBeGreaterThan(0)
  })
})

describe("TranscriptStore", () => {
  test("evicts the least recently used session from memory", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"), { maxCachedSessions: 2 })
    captureRequest(store, "s1", [user("m1", "a")])
    captureRequest(store, "s2", [user("m2", "b")])
    const first = store.read("s1")
    const second = store.read("s2")

    // Touch s1 so s2 becomes the oldest, then overflow the cache.
    store.read("s1")
    captureRequest(store, "s3", [user("m3", "c")])

    expect(store.read("s1")).toBe(first)
    // s2 was evicted, so it is parsed again and comes back as a new object.
    expect(store.read("s2")).not.toBe(second)
  })

  test("clips a huge tool result to the per-message limit", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"), { maxMessageChars: 5_000 })
    captureRequest(store, "s1", [
      toolCall("m1", "call_1", "read", { path: "big.txt" }),
      toolResult("m2", "call_1", "read", { content: "x".repeat(50_000) }),
    ])

    const result = store.read("s1").messages.map((entry) => entry.message).find((m) => m.role === "toolResult") as any
    expect(result.content.length).toBeLessThan(6_000)
    expect(result.content).toContain("clipped")
  })

  test("sweeps transcripts that have not been touched for a while", () => {
    const dir = join(temp(), "transcripts")
    const store = new TranscriptStore(dir)
    captureRequest(store, "s1", [user("m1", "a")])

    const path = join(dir, "s1.jsonl")
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    utimesSync(path, old, old)

    expect(store.sweep(7 * 24 * 60 * 60 * 1000)).toBe(1)
    expect(() => statSync(path)).toThrow()

    // A fresh file is kept.
    captureRequest(store, "s2", [user("m2", "b")])
    expect(store.sweep(7 * 24 * 60 * 60 * 1000)).toBe(0)
  })

  test("survives a restart", () => {
    const dir = join(temp(), "transcripts")
    const store = new TranscriptStore(dir)
    captureRequest(store, "s1", [user("m1", "a")])

    const reopened = new TranscriptStore(dir)
    expect(reopened.read("s1").messages).toHaveLength(1)
  })
})
