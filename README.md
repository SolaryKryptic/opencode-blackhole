# opencode-blackhole

Deterministic compaction + observational memory for **OpenCode**.

A port of [pi-blackhole](https://github.com/k0valik/pi-blackhole) (for the Pi agent)
to OpenCode V2, built on the [pi-vcc](https://github.com/sting8k/pi-vcc) compaction
engine (both MIT).

**What it does**

1. **Replaces OpenCode's LLM summarizer with a structured checkpoint.**
   OpenCode's compaction calls the model to write a prose summary, then compacts
   that summary, and the next one — details erode over a long session. This plugin
   answers OpenCode's `compaction` hook itself. The inventory is extracted
   deterministically — goal, files, commits, preferences, outstanding context,
   with exact paths, commands and identifiers — and one small model call writes
   the part no extractor can: `[Decisions]` (and why), `[Work State]`,
   `[Next Move]` and `[Important Context]`. If that call fails, the deterministic
   summary is used unchanged.

2. **Keeps durable memory across compactions.** A background observer records the
   facts worth keeping (decisions, preferences, constraints, completed work); a
   reflector distils them into durable insights. The memory is injected into the
   system prompt on every request, and both the reflections and the observations
   they rest on ride along with every compaction summary.

3. **Cuts token cost.** One bounded call replaces the summarizer's, the summary
   has a hard token cap, and the workers run on cheap or free models.

---

## Install

### One command

```sh
opencode plugin add opencode-blackhole
```

That is the whole install. OpenCode fetches the package from the npm registry,
caches it in its own store (`~/.cache/opencode/npm/`) and adds it to your
global configuration — no `pnpm add`, no manual config editing.

```sh
opencode plugin list      # see it
opencode plugin check     # check for updates
opencode plugin update    # update it
opencode plugin remove opencode-blackhole
```

Restart OpenCode (or `/reload`) afterwards.

### The same thing by hand

If you prefer to edit the config yourself, add it to your **global** config
(`~/.config/opencode/opencode.json`) to use it everywhere, or to a project's
`opencode.json` for just that project:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-blackhole"]
}
```

To remove it, prefix the name with `-` (it is applied last, so it also
cancels an auto-discovered copy):

```jsonc
{ "plugins": ["-opencode-blackhole"] }
```

### From a local checkout

```jsonc
{ "plugins": ["/absolute/path/to/opencode-blackhole"] }
```

or, as a plugin file anywhere OpenCode looks for one:

```ts
// ~/.config/opencode/plugins/blackhole.ts
export { default } from "/absolute/path/to/opencode-blackhole/index.ts"
```

A checkout must be built first — the plugin loads a bundled `dist/server.js`:

```sh
bun install && bun run build
```

> Requires OpenCode V2 (`@opencode/plugin` ≥ 2.0.28) and Node ≥ 22.13.

### What works without any setup

The compaction half works immediately with whatever model you already use: it
replaces the summarizer call with a deterministic extraction, so it needs no
extra provider, no key and no cost.

The **memory** workers default to `openrouter/openrouter/free`, which needs an
OpenRouter account and key. Without one they fall back to **your session's
model** — so memory still works out of the box, at the cost of a background
call on the model you are already paying for. To keep the workers on a free
tier, give OpenRouter a key; to keep them off your main model entirely, set
`"sessionFallback": false` and point them at a model you choose:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-blackhole",
      "options": {
        "memory": {
          "observerModel": { "providerID": "openai", "id": "gpt-4.1-mini" },
          "reflectorModel": { "providerID": "openai", "id": "gpt-4.1-mini" }
        }
      }
    }
  ]
}
```

The workers run through OpenCode's own generation API, so they use the
credentials you have connected in OpenCode — there is no second key to
configure. Two caveats:

- OpenCode's **free-tier models cannot be called from a plugin** ("OpenCode's
  free tier can only be used from within OpenCode"), so if your session model is
  one of those, it is not usable as the fallback. Use a provider model.
- A worker model that is not in the catalog is skipped without a cooldown. A
  transient failure (rate limit, timeout, an upstream provider error behind a
  router) is retried once on the same model, then cooled down for three minutes
  — a router like `openrouter/free` picks a provider per request, so the retry
  usually lands somewhere else. A deterministic failure (bad key, rejected
  payload) is cooled for the full `cooldownSeconds` and the chain moves on to
  the next candidate.
- When a stage ends with no model at all, the session gets one notice with the
  last error, so a busy upstream is not mistaken for a missing key.

---

## Configuration

Plugin options in `opencode.json` win over a project file
(`.opencode/blackhole.json`), which wins over the global file
(`~/.config/opencode/blackhole.json`), which wins over the defaults.

```jsonc
{
  "plugins": [
    {
      "package": "opencode-blackhole",
      "options": {
        "enabled": true,
        "compaction": {
          "enabled": true,
          "brief": false,           // keep the ranked transcript tail (duplicates OpenCode's kept tail)
          "briefTokens": 2000,      // token budget for the brief, when enabled
          "maxSummaryTokens": 4000, // hard cap for the whole summary
          "extraNote": "",          // extra text appended to every summary
          "handoff": false,          // one model call for the narrative block
          "handoffModel": { "providerID": "openrouter", "id": "openrouter/free" },
          "handoffFallbacks": [],
          "handoffMaxTokens": 900,      // budget for the block itself
          "handoffInputMaxTokens": 12000, // how much conversation the prompt carries
          "handoffTimeoutSeconds": 120  // past this, keep the deterministic summary
        },
        "memory": {
          "enabled": true,
          "observerModel":  { "providerID": "openrouter", "id": "openrouter/free" },
          "reflectorModel": { "providerID": "openrouter", "id": "openrouter/free" },
          "dropperModel":   { "providerID": "openrouter", "id": "openrouter/free" },
          "observerFallbacks":  [],
          "reflectorFallbacks": [],
          "dropperFallbacks":   [],          "sessionFallback": true,  // the session's model is the last resort (does not work on opencode free models)
          "observeAfterTokens": 15000,
          "reflectAfterTokens": 15000,  // upstream uses 25000; see the notes below
          "observerChunkMaxTokens": 40000,  // the most the observer sees at once
          "observerRefine": true,  // a second pass reviews the observer's draft
          "observationsPoolMaxTokens": 20000,
          "retryGateSeconds": 30,
          "cooldownSeconds": 3600
        },
        "recall": {
          "enabled": true,
          "responseMaxChars": 48000  // 0 = unbounded
        },
        "retention": {
          "transcriptDays": 7,   // 0 = keep forever
          "memoryDays": 90,      // the ledger holds the session's memory
          "logDays": 7
        },
        "limits": {
          "maxCachedSessions": 8,     // parsed sessions kept in memory
          "maxMessageChars": 262144,  // cap on a single stored message
          "maxLedgerBytes": 65536     // a ledger is compacted past this
        },
        "logLevel": "off" // "info" | "debug" writes a JSONL trace
      }
    }
  ]
}
```

**Worker model resolution:** `observerModel` → `observerFallbacks[]` → (the
session's model, because `sessionFallback` defaults to true, as upstream does).
A model that fails gets a persisted cooldown and is skipped on later attempts; a
stage that cannot run is skipped, and the coverage cursor never advances past
what a worker actually saw — so nothing is lost, it is just observed later.

The observer is shown at most `observerChunkMaxTokens` of the pending window at
a time (upstream's limit). The chunk it reads is covered; the rest stays
pending for the next round, and an answer the plugin cannot parse leaves the
window pending rather than discarding it. The reflector keeps its own cursor:
each observation is crystallised once, so repeated runs cannot pile up
duplicate reflections.

**The observer runs two passes** (`observerRefine`, on by default). The first
extracts a draft; the second sees that draft next to the same transcript and
returns the corrected list — the facts the first pass missed, the ones it got
wrong, the ones that were never durable. Upstream gets the same effect from
its agent loop, which reads its own first batch back; OpenCode's plugin API
has no tool loop, so the review is a second call instead. A review that fails
or comes back empty keeps the draft, so the second pass can only improve
things. It costs one more request per chunk against your worker model's
limits — turn it off with `"observerRefine": false` to go back to one call.

`reflectAfterTokens` is 15,000 rather than upstream's 25,000 because this
port's observation pool is a hard delete at 20,000, while upstream's is a
budget on the projection: at 25,000 the reflector could never fire here.

Set `"sessionFallback": false` if you would rather the workers stop than run on
your session's model: then a worker with no reachable model is skipped and the
session says so once.

---

## Commands and tools

| Command | Description |
| --- | --- |
| `/blackhole` | Compact now with blackhole's checkpoint (no summarizer call) |
| `/blackhole-recall <query>` | Search this session's history (`page:N`, `scope:all`, `#N:path`) |
| `/blackhole-memory` | Show the memory status: observations, reflections, pending tokens |
| `/blackhole-export [out:<path>.md]` | Export the session's memory as markdown |

The agent also gets a `blackhole_recall` tool: keyword/regex search, entry
ranges, full-text expansion of a `#N` reference, and the list of files worked on.
`#N` is the same index that appears in the summary refs (`(#12)`).

A recall response is bounded by `recall.responseMaxChars` (48,000 by default):
the budget is shared across the entries of a response, and each entry's lines
share their slice of it, so one huge stored message cannot flood the context it
was meant to help with. Set it to `0` for unbounded output.

---

## How the compaction is replaced

OpenCode's compaction hook fires for automatic compaction, overflow recovery and
`/compact`. The plugin answers it with a summary, and OpenCode skips its own
summarizer call — the compaction message then carries a zero-usage summary plus
OpenCode's own verbatim tail.

The summary has two halves. The **sections** are extracted from the transcript
without a model: session goal, files read/modified/created, commits, user
preferences, outstanding context. They hold exact paths and identifiers but say
nothing about *why* a thing was done. The **handoff block** is one model call for
exactly that gap — `[Decisions]`, `[Work State]`, `[Next Move]`,
`[Important Context]` — placed after the sections and before the recall note.

The block is additive: a failed, slow (past `handoffTimeoutSeconds`) or
unparseable response leaves the deterministic summary untouched. When the model
is unreachable, a smaller block is derived without one: the work state from the
commits, the modified-file count and the last command, plus the question the
session ended on. It never guesses a decision. Turn the whole thing off with
`"handoff": false` to get the purely deterministic summary.

The brief transcript (`"brief": true`) is off by default: OpenCode already keeps
the newest exchange verbatim, so the brief mostly duplicates it. It remains
useful if you compact very long sessions on a model with a small kept tail.

If the extraction produces nothing usable, the plugin leaves the hook result
unset and OpenCode falls back to its native summarizer. A compaction never
happens without a summary.

---

## Known differences from pi-blackhole

* **Tail policy** is OpenCode's: the newest exchange is kept verbatim by the
  core (`compaction.keep.tokens`), and the plugin's summary covers the rest.
* **Provider-native compaction** (Claude/GPT server-side context management)
  bypasses the plugin hook entirely. Every other model — including everything
  served through OpenRouter — goes through the deterministic path.
* **The dropper proposes, a deterministic rule decides.** Upstream's dropper
  asks a model which observations are safe to remove, then ranks whatever it
  proposed and caps the count. This port does the same: one call proposes the
  ids, and the deterministic rule still decides which of them actually go —
  least supported first, oldest within a tier. When the model cannot be
  reached, the rule alone prunes the pool, so the pool always falls under its
  cap.
* **Workers use one-shot structured calls.** OpenCode's plugin API has no
  tool-calling loop, so the observer cannot refine its output over several
  turns. It gets a second pass instead: the draft comes back for review
  against the same transcript, and the corrected list replaces it
  (`observerRefine`).
* **No interactive settings overlay** — the CLI plugin surface is out of scope.

---

## State on disk

The state lives **next to OpenCode's own data, in your home directory — not
inside your project**:

```
~/.local/share/opencode/blackhole/
  <projectID>/
    transcripts/<sessionID>.jsonl   # the session transcript (for recall)
    memory/<sessionID>.jsonl        # observations, reflections, coverage cursor
  cooldowns.json                    # worker model cooldowns
  blackhole.log                     # trace (logLevel: debug)
```

A project's folder is keyed by OpenCode's `projectID`, not by its path, so
moving or renaming the project keeps its history. Your repository is never
written to — there is nothing to add to `.gitignore`, and no conversation
content is synced to a cloud drive with your code.

**Nothing grows without bound.** Transcripts expire after `retention.transcriptDays`
(7 by default) — they duplicate what OpenCode already stores in the session
record, so only the searchable index is lost. Ledgers hold the session's actual
memory, so they are kept much longer (`retention.memoryDays`, 90 by default)
and are compacted in place once they pass `limits.maxLedgerBytes`: the live
observations, the reflections and the cursor are rewritten, and the dropped
markers are folded into a counter. At most `limits.maxCachedSessions` sessions
are held in memory at once, and a single stored message is clipped to
`limits.maxMessageChars`.

**Privacy:** the transcript stores the full text of your tool output on disk,
locally, in your home directory. If you paste secrets into a session, they end
up in that file until it expires. Use `retention.transcriptDays: 0` to keep
them forever, or a short window to keep them less.

---

## Development

```sh
bun install
bun run check      # typecheck + tests + build
bun run dev        # rebuild the bundle on every source change
bun run bench      # where the time goes in the capture path
```

**The plugin loads the bundle, not the sources.** A change under `src/` only
reaches a running OpenCode after `bun run build` (or `bun run dev`, which does
it for you); OpenCode then reloads the plugin by itself — no restart needed.
Changing the root `index.ts` takes effect immediately, since it is part of the
plugin's own file graph.

To try a local build in OpenCode, point a plugin file at it:

```ts
// ~/.config/opencode/plugins/blackhole.ts
export { default } from "/path/to/opencode-blackhole/index.ts"
```

The compaction engine lives in `src/vcc/` — a port of pi-vcc with the Pi
couplings removed, kept as a separate module so upstream fixes can be merged
rather than re-implemented. `LICENSE.vendor` carries its MIT license, and
`src/vcc/README.md` records exactly what diverges from upstream.

## License

MIT. Ported from [pi-vcc](https://github.com/sting8k/pi-vcc) and
[pi-blackhole](https://github.com/k0valik/pi-blackhole) (both MIT).
