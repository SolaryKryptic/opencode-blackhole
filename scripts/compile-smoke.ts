/**
 * Smoke test for the ported vcc core: build a small OpenCode-style message
 * set, run it through the adapter + compile(), and print the summary.
 *
 *   bun run scripts/compile-smoke.ts
 */
import { compile } from "../src/vcc/core/summarize"
import { toVccMessages } from "../src/adapter/opencode-messages"

const messages = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "We need to add rate limiting to the public API. Prefer Redis, and never log request bodies.",
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "The user wants rate limiting. Let me look at the server code first." },
      {
        type: "tool-call",
        id: "call_1",
        name: "read",
        input: { path: "C:/repo/src/server.ts", limit: 200 },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_1",
        name: "read",
        output: { content: "export function handler() {}\n// rate limiting not implemented yet" },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "The server has no rate limiting yet. I will add a Redis token bucket in src/ratelimit.ts." },
      {
        type: "tool-call",
        id: "call_2",
        name: "write",
        input: { path: "C:/repo/src/ratelimit.ts", content: "export const limiter = createLimiter()\n" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call_2",
        name: "write",
        output: { content: "Wrote 1 file" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Done. Rate limiting now uses Redis. Request bodies are never logged." }],
  },
]

const vccMessages = toVccMessages(messages as any)
console.log("--- normalized messages:", vccMessages.length, "---")
console.log(JSON.stringify(vccMessages, null, 1).slice(0, 900))
console.log("\n--- compiled summary ---")
console.log(compile({ messages: vccMessages }))
