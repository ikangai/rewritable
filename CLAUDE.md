# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository contents

- `re-write-able-spec.md` — canonical container spec (source of truth, currently v0.8)
- `rwa-edit-spec.md` — **rwa-edit/1 anchor-based edit protocol** (currently v1.4). Defines how the agent expresses changes via `apply_edits` / `replace_document` tool calls instead of wholesale document rewrites.
- `re-write-able-spec.html` — worked-example reference: the spec itself rendered as a re-writeable document. Bootstrap regenerated from `seeds/rewritable.html`.
- `hello.html` — minimal base variant: a one-line "hello world" wrapped in the canonical bootstrap. Bootstrap regenerated from `seeds/rewritable.html`.
- `seeds/rewritable.html` — **canonical bootstrap seed**. Both the service and the CLI read this to emit fresh containers. Has a nil-UUID sentinel that is substituted at emit time.
- `service/` — Node HTTP service that hands out fresh containers via `/new`. Build context is the **repo root** (so it can `COPY seeds/`); see `service/Dockerfile` and `service/docker-compose*.yml`.
- `cli/` — `rwa` npm package (the CLI). `rwa new` emits a fresh container; `rwa import <file>` converts md/html/txt into one. Reads the canonical seed in dev; ships its own bundled copy on `npm publish` via the `prepublishOnly` hook.
- `README.md` — short pitch

The references and seed have no build step — "run" = open the `.html` in a browser, "test" = open the `.html` in a browser. The CLI has a `package.json` with one runtime dep (`marked`). There is no test suite or lint config at the repository level.

If the user asks you to update the container spec, edit `re-write-able-spec.md` and treat the `.html` rendering as derived (regenerate or note drift).

If the user asks you to update the edit protocol, edit `rwa-edit-spec.md` (versioned `rwa-edit/N`).

If the user asks you to update the bootstrap, edit `seeds/rewritable.html` (the canonical copy). `hello.html` and `re-write-able-spec.html` carry their own `DOC_UUID` and `INLINE_DOC` content but their bootstrap should mirror the seed — regenerate by substituting `DOC_UUID`, `FILE`, and `INLINE_DOC` body into the seed.

## What re-write-able is (architecture in one page)

A re-writeable file is a single self-contained `.html` that renders, stores, modifies, and exports itself with no server. The file ships with three pieces inside one `<script id="rwa-bootstrap">` block:

```
container.html
├── DOC_UUID            — per-container UUID, baked at creation
├── INLINE_DOC          — frozen snapshot of the document (template literal)
└── runtime + loader    — IDB helpers, FSA commit, ⌘K/⌘Z/⌘S, agent call
```

The bootstrap is immutable. **Only the contents of the `INLINE_DOC` template literal change between commits.** `DOC_UUID`, the loader, and the runtime bytes are byte-identical from open to commit to next open.

### The rewrite loop (rwa-edit/1)

`⌘K` → acquire modify mutex → read current doc from IDB (LF-canonical) → call agent with `apply_edits` and `replace_document` tools (multi-turn tool-use loop, retry budget 3) → on a successful tool call: validate, then atomically commit `(rwa_doc, rwa_undo, rwa_hist)` in a single IDB transaction → re-render → release mutex.

`⌘Z` pops `rwa_undo`. `⌘S` rebuilds the file (FROZEN bytes + `escapeForTL(currentDoc)` between the INLINE_DOC backticks) and writes it: in-place via FSA on Chromium, downloaded blob otherwise. The agent never sees the bootstrap — only the document.

The agent emits **edits, not documents**: `apply_edits` carries `(find, replace)` pairs that anchor on unique substrings. The runtime applies them as exact string substitutions, so unchanged regions are byte-identical. `replace_document` is the escape hatch for scaffolding or wholesale redesigns. See `rwa-edit-spec.md` for the protocol; the runtime never auto-falls back from `apply_edits` to `replace_document`.

### Per-container IndexedDB (the v0.7 invariant)

Every container's private IndexedDB lives under `rwa_<DOC_UUID>` — *not* the shared `rwa` database. Earlier drafts (v0.4–v0.6) used a single `rwa` DB for all containers, which under `file://` (null origin) made every container shadow whichever one last committed. v0.7 closes this by namespacing the database with the build-time UUID.

| Tier | Where | Holds |
|---|---|---|
| **Per-container IDB** (`rwa_<DOC_UUID>`) | private | `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_fsa`, plus document-defined stores |
| **Shared IDB** (`rwa_shared`) | opt-in | `runtime.shared.*` — composition surface for cross-container reads/writes (spec §5.7, §11.5) |
| **OPFS** (`_rwa/`) | shared null origin (not yet UUID-namespaced — known gap) | binary blobs |
| **sessionStorage** | per tab | OpenRouter API key only — never persisted |
| **Filesystem** | the container itself | bootstrap with current `INLINE_DOC` |

**Reserved namespaces** — runtime owns these; documents must not write them directly:
- IDB databases: `rwa_<DOC_UUID>`, `rwa_shared`
- IDB stores within `rwa_<DOC_UUID>`: anything matching `rwa_*`
- IDB record `kind` field within `rwa_hist`: `"edit_batch"`, `"replace_document"` (rwa-edit/1)
- OPFS paths: `_rwa/`
- HTML element ID: `#rwa-doc-mount` (the render mount)
- Comment prefix substrings inside the doc: `<!-- rwa:`, `/* rwa:`, `// rwa:` and the marker forms `rwa:frozen:begin <name>` / `rwa:frozen:end <name>` (rwa-edit/1, see `rwa-edit-spec.md` §15)
- HTML attributes: `data-rwa-frozen` (inline frozen-zone declaration), `data-rwa-id` (reserved for v2)

**The bootstrap is the anchor.** It is never in IndexedDB and never visible to the agent. If something goes wrong, reload the file — the inline snapshot is the last known good state, and the runtime can be reset by deleting the container's IDB (`rwa_<DOC_UUID>`).

### Agent contract

System prompt is **editor-first** (not author-first): the agent applies surgical edits to an existing document, not a fresh rewrite. The agent has two tools:

- `apply_edits` — preferred. Submits `(find, replace)` pairs with literal, unique anchors.
- `replace_document` — escape hatch. Submits the entire new doc with a required `reason`.

The runtime drives a **multi-turn tool-use conversation**: on tool-call failure (`find_not_found`, `find_not_unique`, `frozen_zone_violation`, `structural_shape_changed`, etc.), the runtime feeds the structured failure back as a `tool_result` and the model gets another attempt — up to 3. After exhaustion, the user sees the failure code and helper context; no silent escalation.

The agent receives only the document (LF-canonical text that lives inside `#rwa-doc-mount`) and the list of frozen-zone names; the bootstrap, runtime, and inline snapshot are not in the prompt. The agent must not produce reserved marker substrings (`rwa:frozen:begin`, `rwa:frozen:end`, the rwa: comment prefixes, `data-rwa-frozen`) in `find` or `replace`. **Frozen zones are author-declared invariants**: changing them requires external editing of the container file.

Default model: `google/gemini-3-flash-preview` via OpenRouter. The user can override per session via the settings panel (key + model live in `sessionStorage` only). Tool-use quality varies by model — for difficult edits, switching to a strong tool-using model (Claude Sonnet, GPT-4) at runtime usually helps.

### Commit (`⌘S`)

```js
buildFile(currentDoc) =
  FROZEN.slice(0, after_INLINE_DOC_backtick) +
  escapeForTL(currentDoc) +
  FROZEN.slice(closing_INLINE_DOC_backtick);
```

`escapeForTL` escapes `\`, `` ` ``, `${`, and `</script` so the document is safe to re-embed in the template literal. The closing-backtick locator walks the literal honoring backslash escapes.

FSA persistence: the `FileSystemFileHandle` is structured-cloneable in modern Chromium, so it lives in `rwa_<DOC_UUID>.rwa_fsa` and is reused across sessions. Permission can lapse (`prompt`/`denied`/`lost`) — fall back to download mode and surface a regrant affordance.

### Design constraints for documents

- Single self-contained file; CSS inline; JS inline only when the document has interactivity.
- No React, no npm, no build steps. Libraries from `cdnjs.cloudflare.com` only when genuinely needed.
- Dark theme palette: bg `#0e0e0f`, surface `#161618`, border `#2d2d34`, text `#dddde4`, muted `#575766`, accents `#b8ff57` / `#57c8ff` / `#ff5757`.
- Fonts: DM Sans (UI), DM Mono (labels/code), Instrument Serif (display).
- Real seed data, never lorem ipsum.
- Pure-prose documents are valid: a single `<article>` and a stylesheet, no JS.

### Platform reality

iOS Safari evicts IndexedDB aggressively after inactivity or storage pressure. The `navigator.storage.persist()` request and the dirty-state nudge after uncommitted modifications exist because of this. **The exported `.html` on disk is the only durable artifact** — every runtime change should preserve or strengthen that escape hatch. Private/incognito is explicitly unsupported; detect and message clearly.

## Conventions when editing the spec

- The spec is versioned in its closing line (`Spec version 0.8 — ...`). Bump it on material changes and update the trailing summary to describe what changed.
- Cross-references use `§N.M` (e.g. `§5.3`); preserve numbering when reorganizing.
- Load-bearing invariants (listed in the spec's "Invariants" section): the bootstrap is byte-identical except for `INLINE_DOC` contents; each container has its own UUID and IDB; the runtime is never in IDB and never visible to the agent; reserved stores are runtime-only; commits do not carry undo state. Flag any proposed change to these explicitly.

## Conventions when editing the references

- `hello.html` and `re-write-able-spec.html` share their bootstrap with `seeds/rewritable.html`. The standard update flow is **regenerate from the seed**: read the reference's existing `DOC_UUID` and `INLINE_DOC` content, copy the seed wholesale, then substitute `DOC_UUID`, `RWA.FILE`, and the `INLINE_DOC` body back in.
- Each reference ships with its own `DOC_UUID`. Never reuse a UUID across files. Generate fresh: `node -e 'console.log(crypto.randomUUID())'`.
- The agent's system prompt and tool schemas live in the bootstrap (`SYSTEM_PROMPT`, `TOOL_SCHEMAS`). They must match `rwa-edit-spec.md` §8 and §9.1.

## Conventions when editing the CLI (`cli/`)

- The CLI is offline-first. `rwa new` and `rwa import` must work without network. Don't add anything that fetches the seed at runtime.
- The seed is loaded by the CLI from a small candidate list: `cli/seeds/rewritable.html` (the in-package copy that prepublish creates) preferred; `seeds/rewritable.html` (canonical, dev mode) as fallback. Don't add more candidates without thinking about how the search semantics interact with `npm publish`.
- The CLI mirrors three pieces of bootstrap-side logic: `escapeTL` (the template-literal escape), the INLINE_DOC backtick-walk, and the DOC_UUID substitution regex. If any of those change in `seeds/rewritable.html`, mirror the change in `cli/src/seed.mjs`.
- `rwa import` ordering: apply seed-level substitutions (DOC_UUID/title/FILE) on the pristine seed first, *then* drop the imported content into INLINE_DOC. Doing it in the other order causes the `DOC_UUID` substitution to falsely match content the user imported (e.g. when importing another rwa file).
- HTML import keeps `<script>` tags intentionally (rwa documents can be interactive per the spec) and prints a stderr `note:` warning. Don't strip them silently.
