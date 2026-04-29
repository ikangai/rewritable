# re-write-able

*A single HTML file that builds, modifies, and exports itself.*

---

**re** — it does it again. The agent loop, self-modification, iteration over time.
**write** — not read. Not consume. Author. The read/write web, finally delivered.
**able** — a property of the file itself. Not a permission the OS grants you. Something it *is*.

---

## What it is

A re-writeable file is a `.html` file that:

1. **Renders itself** — open it in any browser, it runs
2. **Stores itself** — its working state lives in IndexedDB; the file itself is the durable record
3. **Modifies itself** — an embedded agent rewrites the file's app content on instruction
4. **Commits itself** — the current state is written back into the file, in place when the browser allows it, as a download otherwise
5. **Requires nothing** — no server, no install, no build step, no account

The file is simultaneously a document, a tool, an application, and its own source code.

## How it works

Open the file in a browser. It's a document the moment it opens — no build screen, no agent call, no waiting. The shipped file already contains a snapshot of its own initial state. From that point:

- `Cmd+K` — tell the app to change itself
- `Cmd+Z` — undo (up to 10 levels)
- `Cmd+S` — commit the current state back into the file (write-in-place on Chromium; download elsewhere)

The file is built around an **immutable bootstrap** — a loader, a runtime, and a frozen snapshot of the app — and a **mutable working copy** that lives in IndexedDB. The agent only sees the app content; it never sees the runtime. On commit, the bootstrap is rewritten with an updated snapshot, and only the snapshot changes.

Send the file by email, put it on a USB stick, commit it to git. The recipient opens it in a browser and it runs.

## The spec

[`re-write-able-spec.md`](re-write-able-spec.md) — the full specification covering architecture, storage model, agent contract, embedding, security, and platform behavior.

## Related

- [clive](https://github.com/ikangai/clive) — the direct ancestor. An LLM that inhabits a terminal.
- [Simon Willison's HTML tools](https://tools.simonwillison.net) — 150+ single-file HTML applications that proved the format is serious.

---

*The web was supposed to be read/write. One file. One sentence. One rewrite at a time.*
