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

Open the file in a browser. It opens in **Document mode** — just the rendered document, the moment it opens, no build screen, no agent call, no waiting. The shipped file already contains a snapshot of its own initial state. Flip to **Edit mode** and the editing surfaces below appear; Document mode stays clean for reading, printing, and sharing. From that point:

- **Modes** — a rewritable starts in **Document** mode (read-only chrome: the rendered document and any registered view, nothing editable). **Edit** mode unlocks the lens, in-place editing, image insertion, and selection commands. Skill-host and workflow containers add **Skills** and **Actions** modes for their own surfaces. Switching is in-memory only — it never commits or mutates the document by itself — and is refused while an edit is mid-flight.
- **The lens** — in Edit mode, a single steerable input docked at the bottom of the viewport. Type prose to append; type a leading `/` to issue a command. Click a figure, code block, or table to anchor the lens to it: now prose inserts after that block and `/edit it` rewrites it (clicking a text block edits it in place instead — see below). The badge on the lens tells you what it's targeting; `Esc` releases. An inline progress chip above the input narrates what the model is doing while an edit runs (*Thinking…* → *Applying edits…* → *Retrying (attempt 2/3)…*), and surfaces structured failure codes inline if the run exhausts its retry budget.
- **Edit by hand** — in Edit mode, click any leaf text block (paragraph, heading, list item, quote, table cell) and edit it directly in the page like ordinary WYSIWYG text, *no model involved*: the caret lands where you clicked, `Enter` commits, `Shift+Enter` adds a line break, `Esc` reverts, blurring commits, emptying the block deletes it (double-click still works as a compatibility path). A leading `/` instead flips that block into *prompt mode* — the typed instruction runs through the same block-scoped agent path as an anchored command, never as content. This is the offline, no-API-key path — your keyboard driving the same surgical commit pipeline the agent uses (one `⌘Z` per edit, the same frozen-zone and structure guards). Attributed in history as `user:edit-surface`.
- **Select to format — type or speak** — in Edit mode, select text inside a block and a small command bar appears: type (or dictate, via the browser's speech recognition) `make it bold`, `italic`, or `inline code`. These compile locally to the same edit envelope — deterministic, no model call, attributed `user:selection-command` / `user:voice-selection`. An unrecognized command fails visibly rather than guessing or quietly calling a model.
- **Images** — drag a photo onto the page (an insertion bar shows where it will land), paste a screenshot, or type `/image` for a file picker. The browser downscales and recompresses on ingest (≤1600 px, WebP, 500 KB per-image budget — refused loudly past that, never silently degraded) and embeds the image **in the file itself** as a data URI, so the document stays one self-contained `.html`. The model never sees the pixels: prompts carry compact `rwa-asset:` tokens, so *"move the photo up"* costs ~60 bytes of context, not 600 KB. Hover an image for a small toolbar — S/M/L width presets (deterministic, no model) and one-click remove; click it to anchor the lens for anything else (`/add a caption`). No model call on insert — instant, one `⌘Z`, attributed `user:image-drop` / `-paste` / `-picker`.
- `Cmd+Z` — undo
- `Cmd+S` — commit the current state back into the file (write-in-place on Chromium; download elsewhere)
- `Cmd+P` — print, or save as PDF. The seed ships a baseline content stylesheet (system fonts, 720 px article width, page-like margins) and a `@media print` block that hides the runtime chrome, applies `@page` margins, protects block integrity (no stranded headings, no split tables), and wraps long unbroken strings (URLs, hashes, code lines in `<pre>`) so nothing is clipped at the right margin. A fresh container prints as a clean page with just its heading; imports (md/csv/docx/pdf) inherit the same defaults so they look like a styled document the moment they open. The 28-fixture print-fidelity suite in `benchmark/scenarios/print/` is the regression net
- **Safety net** — after 5 uncommitted modifications the runtime nudges you to commit; if storage usage crosses 80% it warns; private/incognito mode shows a blocking banner rather than silently letting the browser evict your work. iOS Safari is the worst-case here, but the same safety net runs everywhere.
- **`window.runtime` API** — documents that need structured data or blobs use a small API the runtime exposes: `runtime.db.{open,get,put,del,all,subscribe}` (per-container IDB, BroadcastChannel-backed events), `runtime.fs.{read,write,del,list}` (OPFS, auto-namespaced under `_<DOC_UUID>/` so containers stay isolated), `runtime.modify/commit/undo` (programmatic ⌘K/⌘S/⌘Z), `runtime.status` (`{dirty, fsa, storage}`), and `runtime.on('commit'|'modify'|'status', cb)` for reacting to lifecycle events. The full surface is in spec §7.

The file is built around an **immutable bootstrap** — a loader, a runtime, and a frozen snapshot of the document — and a **mutable working copy** that lives in IndexedDB. The agent only sees the document; it never sees the runtime. On commit, the bootstrap is rewritten with an updated snapshot, and only the snapshot changes.

**Locked regions.** Wrap content in `class="rwa-locked"` (or `<!-- rwa:frozen:begin name --> … <!-- rwa:frozen:end name -->`) and the runtime refuses to anchor on it, refuses edits that overlap it, and refuses wholesale rewrites that would strip it. The right surface for contract templates, tax forms, press releases — anything where part of the document is fixed and the rest is malleable.

**Web addressable.** Every anchorable block (`p`, `h1`–`h6`, `blockquote`, `li`, `figure`, `pre`, `aside`) carries a runtime-assigned `data-rwa-id="…"` — an 8-character base32 name that survives every edit. A URL like `notes.html#7k3p2m9q` resolves to the same block forever, even after the surrounding text gets rewritten fifty times. Frozen zones are skipped, and the agent is instructed to preserve existing IDs verbatim. This is the floor for re-writeables on the web — each container becomes a node in the read/write web (Berners-Lee model: identity is a URL, fragments are stable, composition happens by referencing rather than by editing each other's source).

Under the lens, the agent edits via **anchor-based surgical edits** (rwa-edit/1): it submits `(find, replace)` pairs against unique substrings, and the runtime applies them as exact string substitutions. The 99% of the document the agent did not need to change is byte-identical because the model never re-emitted it. Structural transforms (insert/delete elements, wrap, mass rename, attribute changes) can also be expressed as a small typed DSL (rwa-edit-dsl/1) that the runtime compiles to the same anchor-based form deterministically. For scaffolding or wholesale redesigns, the model can call `replace_document` instead, with a required reason. All three paths validate frozen zones, structural shape (`<script>`/`<style>` counts), and HTML well-formedness before committing atomically.

The agent backend is selectable in the ⚙ settings panel. **OpenRouter** is the default — a hosted model over HTTPS, paid per token. **Ollama**, **LM Studio**, and **atomic.chat** are the local options — point the container at `localhost:11434`, `localhost:1234`, or `127.0.0.1:1337`, pick a tool-capable model (Llama 3.1, Qwen 2.5 Coder, Mistral Nemo, Gemma on MLX, etc.), and the rewrite loop runs on your own machine. All expose the OpenAI-compatible `/v1/chat/completions` shape so the same multi-turn tool-use loop drives all four. CORS must be allowed on the local server first — `OLLAMA_ORIGINS=*` before `ollama serve`, or LM Studio's Developer → "Enable CORS" toggle; atomic.chat allows http(s) page origins out of the box but not `file://` pages (open the container from a local web server or a hosted projection to use it). **Bridge** is the final alternative — the runtime shells out to a localhost CLI bridge (`POST 127.0.0.1:8765/run`) that spawns `claude -p`, which uses your existing Claude subscription and whichever model your `claude` CLI is configured for. Same edit envelopes either way; the runtime doesn't care which backend produced them.

Send the file by email, put it on a USB stick, commit it to git. The recipient opens it in a browser and it runs.

## Getting a fresh file

Three ways, all produce the same self-contained `.html`:

```sh
# CLI — offline, npm
npx rwa new                       # → ./rewritable.html
npx rwa new presentation          # → built-in slide deck (bare word = a kind, or
                                  #   a cwd data-rwa-template="presentation" file)
npx rwa import notes.md           # → ./notes.html  (md/html/txt/csv/docx/pdf)
npx rwa import invoice.pdf        # PDF → editable HTML, geometry reconstructed
                                  #   (positioned text + drawn rules); deterministic, offline
npx rwa import scan.pdf --vision  # PDF → HTML via an OpenRouter vision model
npx rwa import scan.pdf --claude  # PDF/docx → HTML via local `claude -p` + the
                                  #   pdf/docx skills under ~/.claude/skills/
```

`rwa new <name>` resolves the bare word **template-first, then kind**: a `.html` in
the current folder labeled `data-rwa-template="<name>"` is cloned (fresh `DOC_UUID`,
label stripped); otherwise a built-in kind (`document`, `workflow`, `presentation`,
`workspace`, `skill-host`) is scaffolded. `new`/`import` are deterministic and offline.

```sh
# Workspace — a folder-level control center over sibling rewritables
npx rwa workspace create notes/   # → notes/rwa-index.html (a workspace-kind rewritable)
npx rwa workspace sync notes/     # refresh its manifest from the .html files in notes/
```

`rwa workspace create <dir>` writes a `rwa-index.html` whose editable body holds shared
context for the folder (workspace memory, guidelines, examples, open questions) and whose
frozen manifest lists the sibling rewritables in that directory. `sync` refreshes the
manifest from disk while preserving the edited context; when the index is open it also shows
same-directory rewritables that are currently open (live presence over the runtime bus),
marked *new since sync* until the next `sync` writes them into the manifest.

```sh
# Intent-driven creation — scaffold AND fill, in one command (calls a model)
npx rwa create a presentation about the rewritable architecture
npx rwa create an interactive doc that visualizes token usage --data tokens.json
npx rwa draft presentation --from ./q2-deck.html --data q3.csv --out q3-deck.html
```

`rwa create` (alias `rwa draft`) bootstraps a container, hands the brief to the
model, and bakes the generated content into the file — which is then an ordinary,
**self-contained** rewritable (edit it with `⌘K`, or re-run for a fresh one). The
leading word picks a frame like `rwa new`; the rest is the brief. Created output is
held to a code-enforced no-external-dependency bar — no runtime CDN/remote
references; charts are hand-rolled SVG/Canvas, data is embedded — so "send the file,
they have everything" always holds. Unlike `new`/`import`, `create` is online (it
calls a model), but its *output* never is.

```sh
# Clone a public webpage into a rewritable (network-bearing sibling of import)
npx rwa clone https://www.ikangai.com/some-post/   # → ./some-post.html
```

`rwa clone <url>` is the online counterpart to `rwa import`: it fetches a public webpage, extracts the main article and title, sanitizes the markup, and bakes it into a fresh container — a blog post becomes an editable, shareable single-file `.html`. Content-only in v1 (the source page's styles aren't cloned; re-style with `rwa skin` or `⌘K`). The fetch is **SSRF-guarded** — `http`/`https` only, private/loopback/link-local/metadata addresses blocked (including via DNS rebinding and redirect re-validation), size-capped, HTML-only. Unlike `new`/`import`, it requires the network.

`rwa new -o` and `rwa import -o` open the resulting file in the default browser. The bootstrap lifts three optional URL params into `sessionStorage` on first paint, then scrubs them from the URL so the values don't sit in browser history. The CLI populates these from environment / `./.env`:

- `OPENROUTER_API_KEY` → `?key=…` (lifted into `rwa_apikey`)
- `RWA_BACKEND` → `?backend=…` (one of `openrouter`, `ollama`, `lmstudio`, `atomic`, `bridge`)
- `RWA_MODEL` → `?model=…` (model name string, e.g. `llama3.1:latest` or `qwen2.5-coder-7b-instruct`)

So `RWA_BACKEND=ollama RWA_MODEL=llama3.1:latest rwa new -o` opens a fresh container already wired to your local Ollama. (Base URLs default to `localhost:11434` / `localhost:1234` / `127.0.0.1:1337`; override in the ⚙ settings panel if needed.)

```sh
# Service — hosted
open    https://rewritable.ikangai.com                         # landing page: pitch, download, copy-the-skill, FAQ
curl -O https://rewritable.ikangai.com/rewritable.html         # blank container
curl -O https://rewritable.ikangai.com/skill.zip               # build-skill bundle: SKILL.md + INLINE_DOC examples
open    https://rewritable.ikangai.com/import                  # browser: drop md/csv/txt/html/docx/pdf
open    https://rewritable.ikangai.com/demo/html-effectiveness/ # gallery: 20 example pages, original vs. rewritable
```

Or hand-craft: copy `seeds/rewritable.html`, replace the nil `DOC_UUID` with a fresh `crypto.randomUUID()`, save.

## Updating in place

`rwa edit` applies an `rwa-edit/1` envelope to an existing container from the command line — same edit grammar as ⌘K, but scriptable. Three invocation forms; all converge on the same atomic splice/write path.

```sh
# Instruction → agent loop → envelope → applied
rwa edit notes.html "Add a section on testing"

# Pipe a tool envelope from stdin (no model call)
echo '{"version":"rwa-edit/1","edits":[{"find":"old","replace":"new"}]}' \
  | rwa edit notes.html

# Or read the envelope from a file
rwa edit notes.html --plan plan.json
```

The instruction path uses the same backend as the browser (OpenRouter / Ollama / LM Studio; configure via `--backend` flag or `RWA_*` env vars). The plan path is deterministic — no API key, no network — meant for skills and CI that compose envelopes in code. Frozen zones, reserved-substring rules, structural-shape checks, and atomic writes apply to both. Full reference: [`cli/README.md`](cli/README.md).

## Sharing a snapshot

From `rewritable.ikangai.com/new` or `/import`, click **Publish & share** to put an immutable snapshot at `<short>.rewritable.ikangai.com/`. Anonymous, 24h expiry, no signup. Each share lives at its own origin (8-char alphanumeric subdomain) so the browser's same-origin policy isolates every share's IDB, sessionStorage, and OPFS — a malicious publisher's bootstrap can't read or enumerate any other share's storage. The published version carries its own `DOC_UUID`, so each viewer's edits land in their own browser-local IDB at that share's origin — they fork the doc locally rather than co-edit. For permanent or collaborative hosting, host the `.html` yourself: any static host works, because the file is the app.

From the command line, `rwa publish <file>` does the same in one step — it POSTs a local rewritable to the share service and prints the URL:

```sh
rwa publish notes.html          # → https://<short>.rewritable.ikangai.com/
rwa publish notes.html --json   # {"short":"…","url":"…","expiresAt":…} on stdout
```

Intentionally online (the offline-first guarantee of `new`/`import` doesn't apply to publishing). `--url` overrides the service base for self-hosted deployments.

For a **durable** share that doesn't expire, `rwa publish-site <file>` is the counterpart to `rwa publish`: it scps the file verbatim onto a static site you control and prints the live URL — same bytes, your own host, no 24h sweep.

```sh
RWA_SITE_HOST=user@host RWA_SITE_PATH=/var/www/r RWA_SITE_URL=https://example.com/r \
  rwa publish-site my-doc.html        # → ✓ Published to https://example.com/r/my-doc.html
```

Config is flags-over-env — `RWA_SITE_HOST` / `RWA_SITE_PATH` / `RWA_SITE_URL`, each overridable by `--host` / `--path` / `--url`. Network-bearing, like `rwa clone`.

## Sharing at a stable link (connected share)

A snapshot share (above) is one-shot: a new URL every time, gone in 24h. A **connected share** gives a document a *stable* URL it can publish new versions to. Click **↗** in the file's status bar:

- **Create share link** — publishes the current state to `<short>.rewritable.ikangai.com/` and keeps an update token, machine-local, in the container's private IndexedDB. The token never appears in the page or in the saved file.
- **Publish this version** — pushes your current state to the *same* URL. The panel always shows where you stand: *"Published 2 h ago · the link shows this version"* or *"behind your latest edits."*
- **Stop sharing** — deletes it. Otherwise a connected share lives as long as it's being viewed or updated (90-day inactivity expiry), not 24 hours.

The framing is deliberate: **the link shows a published version, not your live edits.** Your working state stays in your browser; the file on disk is your checkpoint (`⌘S`); the URL is the version you chose to post — three artifacts, three explicit gestures, every gap visible. Anyone opening the link gets a full self-contained rewritable (with its own fresh `DOC_UUID`, so their local edits never collide with yours) — they can read it, fork it, save it, or share their own copy. These share gestures are the only network calls the runtime ever makes on its own; a file that never opens the ↗ panel never touches the network. Spec: [`re-write-able-spec.md`](re-write-able-spec.md) §5.11; rationale: [`docs/plans/2026-06-11-save-affordance-framings.md`](docs/plans/2026-06-11-save-affordance-framings.md).

## Editing at a distance (hosted runtime)

Publishing (above) shares an immutable snapshot. The **hosted runtime** is its writable counterpart: a zero-dep service (`service/`, the `/r/` API) that stores a rewritable's canonical bytes and speaks the operations contract over HTTP, so the file can be edited from a chat, a phone, or the web — without dethroning it. The bytes the server holds *are* a rewritable; `GET /r/:id/export` always hands back the real `.html`, byte-for-byte what `⌘S` would write. Hosting adds a remote door onto *modify*; it does not create a second source of truth.

- `POST /r` ingests a rewritable and returns `{id, token, url}` — a capability URL whose `#k=` fragment is the only key needed to keep editing (no accounts, no signup).
- `GET /r/:id` serves the real container as a **live editable page**: the same lens and ⌘K, but every commit is applied server-side. The agent still runs in your browser with your own key; the service only ever applies validated `rwa-edit/1` envelopes, so it stays the single deterministic, model-free write path. Every change is a logged commit, so the canonical file is always reconstructable.
- From the CLI, `rwa host notes.html` ingests a local file into a hosted runtime and prints its capability URL.

This is the foundation under remote-edit surfaces (a Telegram bot, a phone line). Self-host it like the share service — serve `/r/:id` per-subdomain (as `/s/` shares are) so each hosted doc's browser storage is origin-isolated. Design + build notes: [`docs/plans/2026-06-07-hosted-edit-foundation-design.md`](docs/plans/2026-06-07-hosted-edit-foundation-design.md).

## Installing skills (the actions layer)

A **skill-host** rewritable (`rwa new skill-host`) can install **skills** — small, permission-gated programs that run inside it. Each ships as a signed `.rwa-skill.json` envelope; installing one opens a **consent dialog** that is the trust anchor: it shows the author's key fingerprint, the exact capabilities requested in plain English, a compound-risk callout, and the code itself. Nothing runs until you affirm.

- **Isolation** — every skill runs in its own Web Worker with capability globals removed (`fetch`, `eval`, `Function`, `indexedDB`, `WebAssembly`, …) and a worker-scoped CSP that blocks remote `import()`. A skill reaches the outside world only through a narrow, per-call-gated bridge.
- **Permission tiers** — a skill declares exactly what it needs: `network:<host>` (origin-scoped fetch), `vault:<ns>` (machine-local encrypted credentials, never in the file), `bus:<topic>` (messages to other rewritables on the machine), `fsa:<scope>` (scoped OPFS files), `idb:<store>` (a scoped data store). The runtime enforces each on every call — an undeclared destination is denied, not waved through.
- **Kinds** — `compute` (pure, no bridge), `tool` (bridged, signed), `hook` (event-triggered: fires `on-commit`/`on-open`/`on-mode-change`, fire-and-forget, written to an audit log), and `view` / `edit-surface` (zero-capability DOM authors: a view renders the document into a read-only overlay, an edit-surface returns a deterministic `rwa-edit/1` transform — both validated before they touch the page).
- **Identity is the key, not the name** — skills are Ed25519-signed; the dialog flags an exact- or near-name match from a *different* author, and a Unicode-homoglyph of a trusted name (cyrillic `а` for latin `a`) is hard-blocked. A first-time author shows a key fingerprint (TOFU); a repeat author shows "trusted, N installs."
- **Multi-agent roles** — a skill-host can install signed **agents**: named roles (reviewer, writer) each with their own system prompt and scoped credentials, so a workspace can hand work between roles, each reaching only what its role permits.
- **Discover & distribute** — a service-hosted, read-only **signed-skill index**: `rwa skill publish` posts a signed envelope; the runtime can browse the index, fetch a skill, verify its signature client-side, and install it through the same consent dialog. Authors can cryptographically **revoke**. The index only informs — install-time review stays the trust anchor.
- **Portable credentials** — the vault is machine-local by default, but you can **export** chosen namespaces under a separate transport passphrase (a self-contained `rwa-vault-export/1` file) and **import** them on another machine — fully offline, no account.
- **CLI** — `rwa install <skill> <host>` stages a skill into a skill-host offline (gated identically to the browser); `rwa skill publish <skill>` posts a signed skill to the index.

Compute skills can opt into a warm **Worker pool** (reused across invocations, idle-evicted, hard-capped) for high-frequency use; tools always spawn fresh. Every skill stays isolated per invocation either way.

The honest boundary: the runtime shows you what a skill *can* do; it cannot tell you whether it *should*. Within its granted permissions, the skill's code decides what to do — so the human install review is the real trust anchor. Spec: [`docs/specs/re-write-able-actions-spec-v0.8.md`](docs/specs/re-write-able-actions-spec-v0.8.md) (built); the v0.9 additions (more tiers, agents, hooks, confusable detection) are specified in [`docs/specs/re-write-able-actions-spec-v0.9.md`](docs/specs/re-write-able-actions-spec-v0.9.md) (built).

## Talking to it from a chat or a phone

The messaging and voice surfaces in `surfaces/` are **adapters onto the one contract** — they reimplement no rewritable logic, they shell out to the `rwa` CLI and (for editing) the hosted runtime above. The file stays canonical; each surface is just another door onto *bootstrap / import / modify / describe / publish*.

- **Telegram bot** ([`surfaces/telegram/`](surfaces/telegram/README.md)) — DM it text, a markdown file, or a document and it replies with a published rewritable (Phase A: create-and-publish, ephemeral 24h share, no backend key needed for the wrap path). Set `RWA_FOUNDATION_URL` and Phase B turns on: the bot creates **editable hosted docs** and edits them **in-chat** — a plain message becomes an edit instruction against the chat's active doc, with `/show` and `/export` (the offline escape hatch). Long-poll, no webhook; shells out to the `rwa` CLI over argument arrays.
- **Phone (voice spike)** ([`surfaces/phone/`](surfaces/phone/README.md)) — call a number and **talk to one bound hosted rewritable**: ask it questions or speak a change and have it edited, over Twilio's `<Gather speech>` / `<Say>`. A **timeboxed spike** (happy-path only). Gated on Twilio creds + a public URL; the webhook is unauthenticated, so bind only a throwaway/demo doc (HMAC request-signing is the production follow-up).

## The specs

- [`re-write-able-spec.md`](re-write-able-spec.md) — the container spec: architecture, storage model, agent contract, embedding, security, platform behavior. Currently v0.15.
- [`rwa-edit-spec.md`](rwa-edit-spec.md) — the anchor-based edit protocol the agent uses to modify documents. Currently rwa-edit/1 (v1.6).
- [`rwa-edit-dsl-spec.md`](rwa-edit-dsl-spec.md) — the structural-transform DSL layered on rwa-edit/1: a small typed vocabulary (`replace`, `insert`, `delete`, `set_attr`) the runtime compiles to anchor-based edits. Currently rwa-edit-dsl/1 (v0.1).
- [`docs/specs/rwa-lens-spec.md`](docs/specs/rwa-lens-spec.md) — the lens edit model: a single steerable input with default and anchored states, slash-discriminated content vs. instruction, class-declared locks, the working-block inline-edit surface, and the selection formatting bubble. Currently rwa-lens/1 (v0.12).
- [`docs/specs/rwa-operations-api.md`](docs/specs/rwa-operations-api.md) — the surface-agnostic operations contract: the five verbs every surface speaks (`bootstrap / import / modify / describe / publish`) and the three shared wire strings (`rwa-edit/1`, `rwa-edit-dsl/1`, `self-description/1`). The routing index that ties CLI, lens, service, hosted runtime, skill, and the messaging/voice adapters to one contract. Currently v0.1 (draft).
- [`docs/specs/re-write-able-actions-spec-v0.8.md`](docs/specs/re-write-able-actions-spec-v0.8.md) — the actions/skill layer: signed skills, the permission tiers, the install-consent trust anchor, Worker isolation, the vault. v0.8 (built); v0.9 additions (agents, hooks, `bus:`/`fsa:`/`idb:` tiers, confusable detection) are specified in [`re-write-able-actions-spec-v0.9.md`](docs/specs/re-write-able-actions-spec-v0.9.md) (built).
- [`CHANGELOG.md`](CHANGELOG.md) — release notes.

## Related

- [clive](https://github.com/ikangai/clive) — the direct ancestor. An LLM that inhabits a terminal.
- [Simon Willison's HTML tools](https://tools.simonwillison.net) — 150+ single-file HTML applications that proved the format is serious.

---

*The web was supposed to be read/write. One file. One sentence. One rewrite at a time.*
