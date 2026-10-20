# `src/vcc` — vendored port of pi-vcc

This directory is a port of **[pi-vcc](https://github.com/sting8k/pi-vcc)**
(MIT — Copyright (c) 2026 sting8k). The full licence text is in
[`LICENSE.vendor`](../../LICENSE.vendor) in the package root; it ships with the
published package, as the MIT licence requires.

pi-vcc is Pi-agnostic pure TypeScript: it turns a conversation into a
structured summary (goal, files, commits, preferences, outstanding context) and
a ranked brief transcript, and it provides the recall/search core. It is the
engine this plugin runs.

## Why it lives here

The port is kept as a **separate, close-to-upstream module** rather than
rewritten. pi-vcc is actively developed, and upstream fixes should be merged,
not re-implemented — which only works if the vendored code stays diffable
against its source.

**Rule for changes here:** keep the divergence from upstream as small as
possible, and never reformat, re-order or "tidy" a file you did not have to
touch. A large diff here costs a future merge.

## What actually changed

Of the 30 files, **21 are byte-identical to upstream** and 2 are new; 7 carry a
small edit, each one removing a Pi coupling:

| File | Change |
| --- | --- |
| `types.ts`, `core/content.ts`, `core/render-entries.ts`, `core/search-entries.ts`, `core/summarize.ts` | `import type { Message } from "@earendil-works/pi-ai"` → `from "./pi-types"` / `"../pi-types"` (a local copy of Pi's message shape) |
| `core/normalize.ts` | the same import change, plus `msg.toolName ?? "tool"` for the optional field |
| `core/drill-down.ts` | `loadAllMessages(sessionFile)` → `loadMessages(messages)`: Pi reads the session from a JSONL file, OpenCode owns its history and passes the messages in |

New files, written for this port:

| File | Purpose |
| --- | --- |
| `pi-types.ts` | the message shape pi-vcc expects, copied from Pi's types so the vendored files need no import of Pi's packages |
| `load-messages.ts` | renders a materialised message list instead of reading a session file |

## Re-syncing with upstream

```sh
git clone https://github.com/sting8k/pi-vcc vendor/pi-vcc   # ignored by git
diff -r vendor/pi-vcc/src src/vcc
```

Port any upstream change by hand, keeping the seven edits above intact. After
re-syncing, `bun run check` must stay green — the vendored code has no
dependency on Pi's packages, which is the whole point of the port.
