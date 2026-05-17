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

- **The lens** — a single steerable input docked at the bottom of the viewport. Type prose to append; type a leading `/` to issue a command. Click a block to anchor the lens to it: now prose inserts after that block and `/edit it` rewrites it. The badge on the lens tells you what it's targeting; `Esc` releases.
- `Cmd+Z` — undo
- `Cmd+S` — commit the current state back into the file (write-in-place on Chromium; download elsewhere)
- **Safety net** — after 5 uncommitted modifications the runtime nudges you to commit; if storage usage crosses 80% it warns; private/incognito mode shows a blocking banner rather than silently letting the browser evict your work. iOS Safari is the worst-case here, but the same safety net runs everywhere.
- **`window.runtime` API** — documents that need structured data or blobs use a small API the runtime exposes: `runtime.db.{open,get,put,del,all,subscribe}` (per-container IDB, BroadcastChannel-backed events), `runtime.fs.{read,write,del,list}` (OPFS, auto-namespaced under `_<DOC_UUID>/` so containers stay isolated), `runtime.modify/commit/undo` (programmatic ⌘K/⌘S/⌘Z), `runtime.status` (`{dirty, fsa, storage}`), and `runtime.on('commit'|'modify'|'status', cb)` for reacting to lifecycle events. The full surface is in spec §7.

The file is built around an **immutable bootstrap** — a loader, a runtime, and a frozen snapshot of the document — and a **mutable working copy** that lives in IndexedDB. The agent only sees the document; it never sees the runtime. On commit, the bootstrap is rewritten with an updated snapshot, and only the snapshot changes.

**Locked regions.** Wrap content in `class="rwa-locked"` (or `<!-- rwa:frozen:begin name --> … <!-- rwa:frozen:end name -->`) and the runtime refuses to anchor on it, refuses edits that overlap it, and refuses wholesale rewrites that would strip it. The right surface for contract templates, tax forms, press releases — anything where part of the document is fixed and the rest is malleable.

**Web addressable.** Every anchorable block (`p`, `h1`–`h6`, `blockquote`, `li`, `figure`, `pre`, `aside`) carries a runtime-assigned `data-rwa-id="…"` — an 8-character base32 name that survives every edit. A URL like `notes.html#7k3p2m9q` resolves to the same block forever, even after the surrounding text gets rewritten fifty times. Frozen zones are skipped, and the agent is instructed to preserve existing IDs verbatim. This is the floor for re-writeables on the web — each container becomes a node in the read/write web (Berners-Lee model: identity is a URL, fragments are stable, composition happens by referencing rather than by editing each other's source).

Under the lens, the agent edits via **anchor-based surgical edits** (rwa-edit/1): it submits `(find, replace)` pairs against unique substrings, and the runtime applies them as exact string substitutions. The 99% of the document the agent did not need to change is byte-identical because the model never re-emitted it. Structural transforms (insert/delete elements, wrap, mass rename, attribute changes) can also be expressed as a small typed DSL (rwa-edit-dsl/1) that the runtime compiles to the same anchor-based form deterministically. For scaffolding or wholesale redesigns, the model can call `replace_document` instead, with a required reason. All three paths validate frozen zones, structural shape (`<script>`/`<style>` counts), and HTML well-formedness before committing atomically.

The agent backend is selectable in the ⚙ settings panel. **OpenRouter** is the default — a hosted model over HTTPS, paid per token. **Ollama** and **LM Studio** are the local options — point the container at `localhost:11434` or `localhost:1234`, pick a tool-capable model (Llama 3.1, Qwen 2.5 Coder, Mistral Nemo, etc.), and the rewrite loop runs on your own machine. Both expose the OpenAI-compatible `/v1/chat/completions` shape so the same multi-turn tool-use loop drives all three. CORS must be allowed on the local server first — `OLLAMA_ORIGINS=*` before `ollama serve`, or LM Studio's Developer → "Enable CORS" toggle. **Bridge** is the fourth alternative — the runtime shells out to a localhost CLI bridge (`POST 127.0.0.1:8765/run`) that spawns `claude -p`, which uses your existing Claude subscription and whichever model your `claude` CLI is configured for. Same edit envelopes either way; the runtime doesn't care which backend produced them.

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

`rwa new -o` and `rwa import -o` open the resulting file in the default browser. The bootstrap lifts three optional URL params into `sessionStorage` on first paint, then scrubs them from the URL so the values don't sit in browser history. The CLI populates these from environment / `./.env`:

- `OPENROUTER_API_KEY` → `?key=…` (lifted into `rwa_apikey`)
- `RWA_BACKEND` → `?backend=…` (one of `openrouter`, `ollama`, `lmstudio`, `bridge`)
- `RWA_MODEL` → `?model=…` (model name string, e.g. `llama3.1:latest` or `qwen2.5-coder-7b-instruct`)

So `RWA_BACKEND=ollama RWA_MODEL=llama3.1:latest rwa new -o` opens a fresh container already wired to your local Ollama. (Base URLs default to `localhost:11434` / `localhost:1234`; override in the ⚙ settings panel if needed.)

```sh
# Service — hosted
open    https://rewritable.ikangai.com                         # landing page: pitch, download, copy-the-skill, FAQ
curl -O https://rewritable.ikangai.com/rewritable.html         # blank container
curl -O https://rewritable.ikangai.com/skill.zip               # build-skill bundle: SKILL.md + INLINE_DOC examples
open    https://rewritable.ikangai.com/import                  # browser: drop md/csv/txt/html/docx/pdf
open    https://rewritable.ikangai.com/demo/html-effectiveness/ # gallery: 20 example pages, original vs. rewritable
```

Or hand-craft: copy `seeds/rewritable.html`, replace the nil `DOC_UUID` with a fresh `crypto.randomUUID()`, save.

## Sharing a snapshot

From `rewritable.ikangai.com/new` or `/import`, click **Publish & share** to put an immutable snapshot at `<short>.rewritable.ikangai.com/`. Anonymous, 24h expiry, no signup. Each share lives at its own origin (8-char alphanumeric subdomain) so the browser's same-origin policy isolates every share's IDB, sessionStorage, and OPFS — a malicious publisher's bootstrap can't read or enumerate any other share's storage. The published version carries its own `DOC_UUID`, so each viewer's edits land in their own browser-local IDB at that share's origin — they fork the doc locally rather than co-edit. For permanent or collaborative hosting, host the `.html` yourself: any static host works, because the file is the app.

## The specs

- [`re-write-able-spec.md`](re-write-able-spec.md) — the container spec: architecture, storage model, agent contract, embedding, security, platform behavior. Currently v0.10.
- [`rwa-edit-spec.md`](rwa-edit-spec.md) — the anchor-based edit protocol the agent uses to modify documents. Currently rwa-edit/1 (v1.4).
- [`rwa-edit-dsl-spec.md`](rwa-edit-dsl-spec.md) — the structural-transform DSL layered on rwa-edit/1: a small typed vocabulary (`replace`, `insert`, `delete`, `set_attr`) the runtime compiles to anchor-based edits. Currently rwa-edit-dsl/1 (v0.1).
- [`docs/specs/rwa-lens-spec.md`](docs/specs/rwa-lens-spec.md) — the lens edit model: a single steerable input with default and anchored states, slash-discriminated content vs. instruction, class-declared locks. Currently rwa-lens/1 (v0.9).
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

## Related

- [clive](https://github.com/ikangai/clive) — the direct ancestor. An LLM that inhabits a terminal.
- [Simon Willison's HTML tools](https://tools.simonwillison.net) — 150+ single-file HTML applications that proved the format is serious.

---

*The web was supposed to be read/write. One file. One sentence. One rewrite at a time.*
