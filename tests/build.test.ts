import { describe, expect, test } from "bun:test"
import { buildSummary } from "../src/compaction/build"

const conversation = [
  { id: "m1", role: "user", content: [{ type: "text", text: "Add rate limiting to the public API. Prefer Redis." }] },
  {
    id: "m2",
    role: "assistant",
    content: [{ type: "tool-call", id: "c1", name: "write", input: { filePath: "C:/repo/src/limit.ts", content: "x" } }],
  },
  { id: "m3", role: "tool", content: [{ type: "tool-result", toolCallId: "c1", name: "write", output: { content: "ok" } }] },
  { id: "m4", role: "assistant", content: [{ type: "text", text: "Added the limiter." }] },
]

describe("buildSummary", () => {
  test("produces a deterministic summary with file activity", () => {
    const result = buildSummary({ messages: conversation, briefTokens: 2000, maxSummaryTokens: 4000 })
    expect(result.summary).toBeDefined()
    expect(result.summary).toContain("Files And Changes")
    expect(result.summary).toContain("limit.ts")
    expect(result.summary).toContain("blackhole_recall")
    expect(result.summary).not.toContain("vcc_recall")
  })

  test("is stable for the same input", () => {
    const a = buildSummary({ messages: conversation, briefTokens: 2000, maxSummaryTokens: 4000 })
    const b = buildSummary({ messages: conversation, briefTokens: 2000, maxSummaryTokens: 4000 })
    expect(a.summary).toBe(b.summary)
  })

  test("rejects an empty conversation so OpenCode can fall back", () => {
    const result = buildSummary({ messages: [], briefTokens: 2000, maxSummaryTokens: 4000 })
    expect(result.summary).toBeUndefined()
    expect(result.rejected).toBeTruthy()
  })

  test("respects the token cap", () => {
    const long = Array.from({ length: 60 }, (_, i) => [
      {
        id: `u${i}`,
        role: "user" as const,
        content: [{ type: "text", text: `message ${i} `.repeat(40) }],
      },
      {
        id: `a${i}`,
        role: "assistant" as const,
        content: [{ type: "text", text: `reply ${i} `.repeat(40) }],
      },
    ]).flat()
    const result = buildSummary({ messages: long, briefTokens: 2000, maxSummaryTokens: 200 })
    expect(result.summary).toBeDefined()
    expect(result.tokens).toBeLessThanOrEqual(200)
  })

  test("merges a previous summary", () => {
    const checkpoint = [
      "<conversation-checkpoint>",
      "<summary>\n[Session Goal]\n- older goal\n</summary>",
      "</conversation-checkpoint>",
    ].join("\n")
    const result = buildSummary({
      messages: [
        { id: "m0", role: "user", content: [{ type: "text", text: checkpoint }] },
        ...conversation,
      ],
      briefTokens: 2000,
      maxSummaryTokens: 4000,
    })
    expect(result.previousSummary).toContain("older goal")
  })

  test("a checkpoint-only request still produces a summary", () => {
    // The window since the last compaction held no new text, so the request
    // carries the checkpoint and nothing else. Declining here would hand the
    // compaction back to OpenCode's own summarizer - a model call this
    // plugin exists to avoid.
    const checkpoint = [
      "<conversation-checkpoint>",
      "<summary>\n[Session Goal]\n- the goal we had\n\n[Files And Changes]\n- Modified: src/a.ts\n</summary>",
      "</conversation-checkpoint>",
    ].join("\n")
    const result = buildSummary({
      messages: [{ id: "m0", role: "user", content: [{ type: "text", text: checkpoint }] }],
      briefTokens: 2000,
      maxSummaryTokens: 4000,
    })
    expect(result.rejected).toBeUndefined()
    expect(result.summary).toBeDefined()
    expect(result.summary).toContain("the goal we had")
  })

  test("a checkpoint-only request carries a foreign checkpoint forward", () => {
    // A summary written by OpenCode's own summarizer has no sections we can
    // merge. It is still a summary of the conversation, so it is carried
    // forward rather than paying a model to rewrite it.
    const checkpoint = [
      "<conversation-checkpoint>",
      "<summary>\n## Objective\n- do the thing\n</summary>",
      "</conversation-checkpoint>",
    ].join("\n")
    const result = buildSummary({
      messages: [{ id: "m0", role: "user", content: [{ type: "text", text: checkpoint }] }],
      briefTokens: 2000,
      maxSummaryTokens: 4000,
    })
    expect(result.rejected).toBeUndefined()
    expect(result.summary).toContain("do the thing")
  })

  test("rejects a request with neither content nor a checkpoint", () => {
    // The safety valve stays: with nothing to summarise at all, OpenCode's
    // summarizer is better than an empty summary.
    const result = buildSummary({
      messages: [{ id: "m0", role: "user", content: [] }],
      briefTokens: 2000,
      maxSummaryTokens: 4000,
    })
    expect(result.summary).toBeUndefined()
    expect(result.rejected).toBeTruthy()
  })
})
