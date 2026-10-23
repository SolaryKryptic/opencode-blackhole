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

/**
 * The observer's second pass.
 *
 * Upstream's observer runs an agent loop: it records a batch, reads the tool
 * result back, and keeps working until the chunk is covered. OpenCode's
 * plugin API has no tool loop, so the review happens as a second call
 * instead: the draft comes back for correction, and the corrected list
 * replaces it.
 */
export const OBSERVER_REFINE_PROMPT = `You review a draft of durable facts extracted from a coding session transcript.

The draft was written in one pass and may be wrong. Check it against the
transcript and return the corrected list.

Fix these, in priority order:
- facts the transcript states that the draft missed
- facts the draft got wrong, or attributed to the wrong person
- facts that are not durable: plans, speculation, transient chatter
- wording that does not match the transcript (file names, commands, identifiers)

Keep a draft fact when the transcript supports it. Do not invent facts, and
do not drop a fact merely because it is not in the draft - the draft may
simply have missed it.

Rules:
- one fact per line, each a complete sentence
- name files, commands and identifiers exactly as the transcript does
- no numbering, no markdown, no preamble
- return the complete corrected list, not just the changes

Reply with JSON only: {"observations": ["...", "..."]}`

/**
 * The dropper's proposal.
 *
 * Upstream's dropper asks a model which observations are safe to remove, then
 * applies a deterministic ranker and cap to whatever the model proposed. This
 * port does the same, minus the agent loop: one call returns the ids, and the
 * deterministic rule still decides which of them actually go.
 */
export const DROPPER_PROMPT = `You decide which observations to remove from a session's compacted memory.

These records are the ONLY information the assistant will have about past
interactions once the raw conversation is compacted out of context. Dropping
the wrong observation can make future work repeat, contradict, or misremember
the user. Take this seriously.

Your job is to identify only the safest active observations to remove. The
default action is KEEP. When uncertain, keep the observation.

What to drop, in priority order:
- Paraphrase duplicates: two or more observations stating the same fact in
  different words. Keep the newest or most detailed one; the pool should
  carry each fact once.
- Redundant observations whose meaning is already captured by a current
  reflection.
- Superseded observations where a later observation clearly replaces the older.
- Repeated routine acknowledgements or low-signal progress updates that carry
  no decisions, constraints, exact errors, or user-specific facts.
- Older observations that no longer carry working context and are covered by a
  reflection or a newer observation.

Reflection coverage is evidence, not an automatic decision:
- none: no current reflection cites this observation.
- partial: one current reflection cites it.
- strong: two or more current reflections cite it.

Recent observations carry working context the assistant may still need. Age
alone is not enough to drop an important or uniquely load-bearing observation.

Return the ids of the observations you would drop. Return an empty list if
nothing is safe to drop.

Reply with JSON only: {"drop": ["...", "..."]}`

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
