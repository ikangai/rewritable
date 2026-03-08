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
2. **Stores itself** — its live state lives in `localStorage`, not on a server
3. **Modifies itself** — an embedded agent rewrites the file's own source code on instruction
4. **Exports itself** — the current state can be saved as a new `.html` file at any time
5. **Requires nothing** — no server, no install, no build step, no account

The file is simultaneously a document, a tool, an application, and its own source code.

## How it works

Open the seed file in a browser. Enter an OpenRouter API key, pick a model, describe what you want. The agent generates a complete app and stores it in `localStorage`. From that point:

- `Cmd+K` — tell the app to change itself
- `Cmd+Z` — undo (up to 10 levels)
- `Cmd+S` — export as a standalone `.html` file

The exported file contains the runtime. It keeps rewriting itself. Send it by email, put it on a USB stick, commit it to git. The recipient opens it in a browser and it runs.

## The spec

[`re-write-able-spec.md`](re-write-able-spec.md) — the full specification covering architecture, storage model, agent contract, embedding, security, and platform behavior.

## Related

- [clive](https://github.com/ikangai/clive) — the direct ancestor. An LLM that inhabits a terminal.
- [Simon Willison's HTML tools](https://tools.simonwillison.net) — 150+ single-file HTML applications that proved the format is serious.

---

*The web was supposed to be read/write. One file. One sentence. One rewrite at a time.*
