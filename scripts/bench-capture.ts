/**
 * Where the time actually goes.
 *
 * Two candidate hot paths in a long session:
 *   1. capture — a request carries the whole conversation, so the old code
 *      re-adapted every message on every request.
 *   2. the memory manager's pending-token accounting — the old code
 *      re-serialized every pending message on every turn end.
 *
 * Run: bun run scripts/bench-capture.ts
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { adaptMessages } from "../src/adapter/opencode-messages"
import { captureRequest } from "../src/store/capture"
import { TranscriptStore } from "../src/store/transcript"

const TURNS = 300
const OUTPUT = "x".repeat(4_000)
const CHARS_PER_TOKEN = 4

const conversation: any[] = []
for (let i = 0; i < TURNS; i++) {
  conversation.push({
    id: `a${i}`,
    role: "assistant",
    content: [{ type: "tool-call", id: `c${i}`, name: "read", input: { path: `file${i}.ts` } }],
  })
  conversation.push({
    id: `r${i}`,
    role: "tool",
    content: [{ type: "tool-result", toolCallId: `c${i}`, name: "read", output: { content: OUTPUT } }],
  })
  conversation.push({ id: `u${i}`, role: "user", content: [{ type: "text", text: `message ${i}` }] })
}

const dir = mkdtempSync(join(tmpdir(), "blackhole-bench-"))
const fmt = (ms: number) => `${ms.toFixed(0)} ms`

// ---------------------------------------------------------------- capture
const store = new TranscriptStore(join(dir, "transcripts"))
const newCaptureStart = performance.now()
for (let turn = 0; turn < TURNS; turn++) {
  captureRequest(store, "bench", conversation.slice(0, (turn + 1) * 3))
}
const newCaptureMs = performance.now() - newCaptureStart

// The old behaviour: adapt the whole request, then drop what we already have.
const legacyStore = new TranscriptStore(join(dir, "legacy"))
const legacyCaptureStart = performance.now()
for (let turn = 0; turn < TURNS; turn++) {
  const request = conversation.slice(0, (turn + 1) * 3)
  const adapted = adaptMessages(request)
  const transcript = legacyStore.read("bench")
  const fresh = adapted.messages.filter((message) => message.id && !transcript.indexById.has(message.id))
  legacyStore.append(
    "bench",
    fresh.map((message, i) => ({ id: message.id!, index: transcript.messages.length + 1 + i, message })),
  )
}
const legacyCaptureMs = performance.now() - legacyCaptureStart

// ------------------------------------------------- pending token accounting
const transcript = store.read("bench")
const messages = transcript.messages

const legacyPendingStart = performance.now()
let legacyTokens = 0
for (let turn = 0; turn < TURNS; turn++) {
  const pending = messages.filter((entry) => entry.index > 0)
  legacyTokens = pending.reduce(
    (sum, message) => sum + Math.ceil(JSON.stringify(message.message.content ?? "").length / CHARS_PER_TOKEN),
    0,
  )
}
const legacyPendingMs = performance.now() - legacyPendingStart

const newPendingStart = performance.now()
let newTokens = 0
for (let turn = 0; turn < TURNS; turn++) {
  const pending = messages.filter((entry) => entry.index > 0)
  newTokens = pending.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0)
}
const newPendingMs = performance.now() - newPendingStart

rmSync(dir, { recursive: true, force: true })

console.log(`turns: ${TURNS}   messages in the final request: ${conversation.length}   tool output: ${OUTPUT.length} chars\n`)
console.log("capture (adapt the request)")
console.log(`  old (adapt everything): ${fmt(legacyCaptureMs)}`)
console.log(`  new (adapt only new):   ${fmt(newCaptureMs)}`)
console.log(`  speedup:                ${(legacyCaptureMs / newCaptureMs).toFixed(1)}x\n`)
console.log("pending token accounting (per turn end)")
console.log(`  old (re-serialize):     ${fmt(legacyPendingMs)}`)
console.log(`  new (precomputed):      ${fmt(newPendingMs)}`)
console.log(`  speedup:                ${(legacyPendingMs / Math.max(newPendingMs, 0.01)).toFixed(0)}x`)
console.log(`  tokens agree:           ${legacyTokens === newTokens}`)
