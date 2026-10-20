import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runRecallTool } from "../src/recall/recall"
import { TranscriptStore } from "../src/store/transcript"
import { captureRequest } from "../src/store/capture"

const temp = () => mkdtempSync(join(tmpdir(), "blackhole-recall-"))

const bigOutput = "zebra " + "x".repeat(200_000)

const seed = (store: TranscriptStore, sessionID: string) => {
  captureRequest(store, sessionID, [
    { id: "m1", role: "user", content: [{ type: "text", text: "the black hole report" }] },
    {
      id: "m2",
      role: "assistant",
      content: [{ type: "tool-call", id: "c1", name: "read", input: { path: "report.txt" } }],
    },
    {
      id: "m3",
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "c1", name: "read", output: { content: bigOutput } }],
    },
    { id: "m4", role: "user", content: [{ type: "text", text: "more about the black hole" }] },
  ])
}

describe("recall response budget", () => {
  test("a search response never exceeds the budget", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    // The huge tool output is the match: it must be clipped, not returned whole.
    const capped = runRecallTool(store, "s1", { query: "zebra" }, { maxChars: 4_000 })
    expect(capped.length).toBeLessThanOrEqual(4_200)
    expect(capped).toContain("clipped")

    const uncapped = runRecallTool(store, "s1", { query: "zebra" }, { maxChars: 0 })
    expect(uncapped.length).toBeGreaterThan(capped.length)
  })

  test("an expanded entry is bounded too", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    const capped = runRecallTool(store, "s1", { expand: [2, 3] }, { maxChars: 4_000 })
    expect(capped.length).toBeLessThanOrEqual(4_200)
  })

  test("the budget is shared across the entries of a response", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    // Many small hits: each gets a slice, so the page stays readable.
    const capped = runRecallTool(store, "s1", { range: [1, 4] }, { maxChars: 4_000 })
    expect(capped.length).toBeLessThanOrEqual(4_200)
  })

  test("a small response is left alone", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    const text = runRecallTool(store, "s1", { query: "black hole report" }, { maxChars: 48_000 })
    expect(text.length).toBeGreaterThan(0)
    expect(text).not.toContain("[response clipped at")
  })

  test("recall numbers match the session-global index used in summaries", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    // The summary refers to entries as #N, 1-based. Recall must agree, or a
    // reference in a summary cannot be expanded.
    const transcript = store.read("s1")
    expect(transcript.messages.map((entry) => entry.index)).toEqual([1, 2, 3, 4])

    const text = runRecallTool(store, "s1", { query: "black hole" }, { maxChars: 48_000 })
    expect(text).toContain("#1 [user]")
    expect(text).not.toContain("#0 ")
  })

  test("a #N reference expands the entry it names", () => {
    const store = new TranscriptStore(join(temp(), "transcripts"))
    seed(store, "s1")

    // Entry #3 is the big tool result.
    const text = runRecallTool(store, "s1", { expand: [3] }, { maxChars: 48_000 })
    expect(text).toContain("#3")
    expect(text).not.toContain("Cannot expand indices outside session history")
  })
})
