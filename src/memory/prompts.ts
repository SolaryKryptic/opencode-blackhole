/**
 * Worker prompts.
 *
 * The observer extracts timestamped facts from a slice of the conversation;
 * the reflector distils those into durable insights. Both are asked for JSON
 * so a small model can be parsed reliably — the models in play here are
 * usually free ones.
 */

export const OBSERVER_PROMPT = `You extract durable facts from a coding session transcript.

Read the transcript and list only the facts that will still matter later:
- decisions the user made, and why ("chose Postgres over SQLite because of concurrent writes")
- stated preferences and constraints ("never log request bodies", "always use pnpm")
- work that was completed, and where it stands ("rate limiter added in src/ratelimit.ts")
- problems hit and how they were resolved
- things the user explicitly asked to remember

Do NOT list:
- the assistant's plans, questions or speculation
- transient chatter, greetings, or restatements of the request
- anything the transcript does not actually say

Rules:
- one fact per line, each a complete sentence
- name files, commands and identifiers exactly as the transcript does
- no numbering, no markdown, no preamble
- if there is nothing durable, output nothing

Reply with JSON only: {"observations": ["...", "..."]}`

export const REFLECTOR_PROMPT = `You distil a list of observations into durable reflections.

A reflection is a stable insight that stays true across the session: a constraint,
a preference, a pattern in how the user wants to work, a decision that shapes
future work. It is not a restatement of one observation.

Rules:
- one reflection per line, a single complete sentence
- keep the original wording of identifiers and file paths
- no numbering, no markdown, no preamble
- if nothing rises above the individual observations, output nothing

Reply with JSON only: {"reflections": ["...", "..."]}`

/** Parse a JSON object out of a model reply that may be wrapped in prose. */
export const parseJson = <T>(text: string): T | undefined => {
  if (!text) return undefined
  const trimmed = text.trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidates = [fenced?.[1], trimmed]
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      return JSON.parse(candidate) as T
    } catch {
      // fall through to the brace-slice attempt
    }
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as T
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined
}
