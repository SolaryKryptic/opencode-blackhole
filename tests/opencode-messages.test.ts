import { describe, expect, test } from "bun:test"
import { adaptMessages } from "../src/adapter/opencode-messages"

const toolResult = (id: string, name: string, output: unknown) => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, name, output }],
})

describe("adaptMessages", () => {
  test("maps user and assistant text", () => {
    const result = adaptMessages([
      { id: "m1", role: "user", content: [{ type: "text", text: "hello" }] },
      {
        id: "m2",
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hi" },
        ],
      },
    ])

    expect(result.messages).toHaveLength(2)
    expect(result.messages[0].role).toBe("user")
    expect(result.messages[1].role).toBe("assistant")
    // Reasoning is not conversation content.
    expect(JSON.stringify(result.messages[1].content)).not.toContain("thinking")
  })

  test("pairs tool calls with their results", () => {
    const result = adaptMessages([
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "tool-call", id: "call_1", name: "read", input: { path: "a.ts" } }],
      },
      toolResult("call_1", "read", { content: "file body" }),
    ])

    expect(result.messages).toHaveLength(2)
    const call = result.messages[0].content as any[]
    expect(call[0].type).toBe("toolCall")
    expect(call[0].name).toBe("read")
    expect(call[0].arguments).toEqual({ path: "a.ts" })
    expect(result.messages[1].role).toBe("toolResult")
    expect(result.messages[1].toolName).toBe("read")
    expect(result.messages[1].content).toBe("file body")
  })

  test("folds shell calls into bashExecution", () => {
    const result = adaptMessages([
      {
        id: "m2",
        role: "assistant",
        content: [{ type: "tool-call", id: "call_1", name: "shell", input: { command: "ls" } }],
      },
      toolResult("call_1", "shell", { content: "a.txt", metadata: { exit: 0 } }),
    ])

    expect(result.messages[1].role).toBe("bashExecution")
    expect(result.messages[1].command).toBe("ls")
    expect(result.messages[1].output).toContain("a.txt")
    expect(result.messages[1].exitCode).toBe(0)
  })

  test("extracts the previous summary from a checkpoint", () => {
    const checkpoint = [
      "<conversation-checkpoint>",
      "The following is a summary and serialized record of earlier conversation.",
      "",
      "<summary>\n[Session Goal]\n- old goal\n</summary>",
      "",
      "<recent-context>\nrecent text\n</recent-context>",
      "</conversation-checkpoint>",
    ].join("\n")

    const result = adaptMessages([
      { id: "m0", role: "user", content: [{ type: "text", text: checkpoint }] },
      { id: "m1", role: "user", content: [{ type: "text", text: "next question" }] },
    ])

    expect(result.previousSummary).toContain("old goal")
    expect(result.previousRecent).toContain("recent text")
    // The checkpoint itself is not part of the conversation.
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].id).toBe("m1")
  })

  test("resolves session-global indices when asked", () => {
    const result = adaptMessages(
      [
        { id: "m1", role: "user", content: [{ type: "text", text: "a" }] },
        { id: "m2", role: "assistant", content: [{ type: "text", text: "b" }] },
      ],
      { resolveIndex: (id: string) => (id === "m1" ? 1 : 2) },
    )
    expect(result.sourceIndices).toEqual([1, 2])
  })

  test("pairs a result with a call seen in an earlier request", () => {
    const calls = new Map<string, { name: string; input: Record<string, unknown> }>()
    const first = adaptMessages(
      [
        {
          id: "m2",
          role: "assistant",
          content: [{ type: "tool-call", id: "call_1", name: "read", input: { path: "a.ts" } }],
        },
      ],
      { calls },
    )
    expect(first.messages[0].content).toBeDefined()
    expect(calls.get("call_1")?.name).toBe("read")

    // The result arrives in a later request, with only the call map carried over.
    const second = adaptMessages(
      [toolResult("call_1", "read", { content: "file body" })],
      { calls },
    )
    expect(second.messages[0].role).toBe("toolResult")
    expect(second.messages[0].toolName).toBe("read")
    expect(second.messages[0].content).toBe("file body")
  })
})
