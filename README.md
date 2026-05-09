# re-write-able

*A single HTML file that renders, modifies, and commits itself — the document that owns its own format.*

---

**re** — it does it again. The agent loop, self-modification, iteration over time.
**write** — not read. Not consume. Author. The read/write web, finally delivered.
**able** — a property of the file itself. Not a permission the OS grants you. Something it *is*.

---

## What it is

A re-writeable file is a `.html` file that:

1. **Renders itself** — open it in any browser, it runs
2. **Stores itself** — its working state lives in IndexedDB; the file itself is the durable record
3. **Modifies itself** — an embedded agent rewrites the document via anchor-based surgical edits, validated and committed atomically; failed edits leave the document untouched
4. **Commits itself** — the current state is written back into the file, in place when the browser allows it, as a download otherwise
5. **Requires nothing** — no server, no install, no build step, no account

The user-authored content is a **document** — sometimes pure prose, sometimes a tracker, sometimes a spreadsheet, often all three at once. Word, Excel, and PowerPoint each picked one mode and made the others awkward; HTML does all three in the same file. `re-write-able` returns the document to the form factor that made office suites work in the first place: a file you own, on disk, that you can send.

## How it works

Open the file in a browser. It's a document the moment it opens — no build screen, no agent call, no waiting. The shipped file already contains a snapshot of its own initial state. From that point:

- `Cmd+K` — tell the document to change itself
- `Cmd+Z` — undo (up to 10 levels)
- `Cmd+S` — commit the current state back into the file (write-in-place on Chromium; download elsewhere)

The file is built around an **immutable bootstrap** — a loader, a runtime, and a frozen snapshot of the document — and a **mutable working copy** that lives in IndexedDB. The agent only sees the document; it never sees the runtime. On commit, the bootstrap is rewritten with an updated snapshot, and only the snapshot changes.

The agent edits via **anchor-based surgical edits** (rwa-edit/1): it submits `(find, replace)` pairs against unique substrings, and the runtime applies them as exact string substitutions. The 99% of the document the agent did not need to change is byte-identical because the model never re-emitted it. Structural transforms (insert/delete elements, wrap, mass rename, attribute changes) can also be expressed as a small typed DSL (rwa-edit-dsl/1) that the runtime compiles to the same anchor-based form deterministically. For scaffolding or wholesale redesigns, the model can call `replace_document` instead, with a required reason. All three paths validate frozen zones, structural shape (`<script>`/`<style>` counts), and HTML well-formedness before committing atomically.

The agent backend is selectable in the ⚙ settings panel. **OpenRouter** is the default — a hosted model over HTTPS, paid per token. **Bridge** is the alternative — ⌘K shells out to a localhost CLI bridge (`POST 127.0.0.1:8765/run`) that spawns `claude -p`, which uses your existing Claude subscription and whichever model your `claude` CLI is configured for. Same edit envelopes either way; the runtime doesn't care which backend produced them.

Send the file by email, put it on a USB stick, commit it to git. The recipient opens it in a browser and it runs.

## Getting a fresh file

Three ways, all produce the same self-contained `.html`:

```sh
# CLI — offline, npm
npx rwa new                       # → ./rewritable.html
npx rwa import notes.md           # → ./notes.html  (md/html/txt/csv/docx/pdf)
npx rwa import scan.pdf --vision  # PDF → HTML via an OpenRouter vision model
npx rwa import scan.pdf --claude  # PDF/docx → HTML via local `claude -p` + the
                                  #   pdf/docx skills under ~/.claude/skills/
```

`rwa new -o` and `rwa import -o` open the resulting file in the default browser. If `OPENROUTER_API_KEY` is set in the environment (or in `./.env`), it's handed to the container via a `?key=…` URL parameter that the bootstrap lifts into `sessionStorage` and immediately scrubs from the URL — so ⌘K works on first open without visiting the settings panel.

```sh
# Service — hosted
curl -O https://rewritable.ikangai.com/rewritable.html         # blank container
open    https://rewritable.ikangai.com/import                  # browser: drop md/csv/txt/html/docx/pdf
```

Or hand-craft: copy `seeds/rewritable.html`, replace the nil `DOC_UUID` with a fresh `crypto.randomUUID()`, save.

## The specs

- [`re-write-able-spec.md`](re-write-able-spec.md) — the container spec: architecture, storage model, agent contract, embedding, security, platform behavior. Currently v0.8.
- [`rwa-edit-spec.md`](rwa-edit-spec.md) — the anchor-based edit protocol the agent uses to modify documents. Currently rwa-edit/1 (v1.4).
- [`rwa-edit-dsl-spec.md`](rwa-edit-dsl-spec.md) — the structural-transform DSL layered on rwa-edit/1: a small typed vocabulary (`replace`, `insert`, `delete`, `set_attr`) the runtime compiles to anchor-based edits. Currently rwa-edit-dsl/1 (v0.1).
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

## Related

- [clive](https://github.com/ikangai/clive) — the direct ancestor. An LLM that inhabits a terminal.
- [Simon Willison's HTML tools](https://tools.simonwillison.net) — 150+ single-file HTML applications that proved the format is serious.

---

*The web was supposed to be read/write. One file. One sentence. One rewrite at a time.*
