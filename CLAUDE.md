# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository contents

- `re-write-able-spec.md` — canonical spec (source of truth, currently v0.8)
- `re-write-able-spec.html` — worked-example reference: the spec itself rendered as a re-writeable document
- `hello.html` — minimal base variant: a one-line "hello world" wrapped in the same v0.7 bootstrap
- `README.md` — short pitch

There is no `package.json`, no build system, no test suite, no lint config. By design. "Run" = open the `.html` in a browser. "Test" = open the `.html` in a browser.

If the user asks you to update the spec, edit `re-write-able-spec.md` and treat the `.html` rendering as derived (regenerate or note drift).

## What re-write-able is (architecture in one page)

A re-writeable file is a single self-contained `.html` that renders, stores, modifies, and exports itself with no server. The file ships with three pieces inside one `<script id="rwa-bootstrap">` block:

```
container.html
├── DOC_UUID            — per-container UUID, baked at creation
├── INLINE_DOC          — frozen snapshot of the document (template literal)
└── runtime + loader    — IDB helpers, FSA commit, ⌘K/⌘Z/⌘S, agent call
```

The bootstrap is immutable. **Only the contents of the `INLINE_DOC` template literal change between commits.** `DOC_UUID`, the loader, and the runtime bytes are byte-identical from open to commit to next open.

### The rewrite loop

`⌘K` → read current document from IDB → call agent (system prompt + document + instruction) → push prior to `rwa_undo` (cap 10) → write returned document to `rwa_doc` → re-render.

`⌘Z` pops `rwa_undo`. `⌘S` rebuilds the file (FROZEN bytes + `escapeForTL(currentDoc)` between the INLINE_DOC backticks) and writes it: in-place via FSA on Chromium, downloaded blob otherwise. The agent never sees the bootstrap — only the document.

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
- OPFS paths: `_rwa/`

**The bootstrap is the anchor.** It is never in IndexedDB and never visible to the agent. If something goes wrong, reload the file — the inline snapshot is the last known good state, and the runtime can be reset by deleting the container's IDB (`rwa_<DOC_UUID>`).

### Agent contract

System prompt is **document-first** (not app-first):

> You are modifying a document. The document may be prose, it may be a tracker, it may be a spreadsheet, it may be all three. Read what is there. Apply the user's instruction to the actual content — its tone if it is prose, its structure if it is data, its behavior if it is interactive.

The agent receives only the document (HTML fragment that lives inside `#rwa-doc-mount`); the bootstrap, runtime, and inline snapshot are not in the prompt. The agent must not emit `<!DOCTYPE>`, `<html>`, `<head>`, or `<body>` — those belong to the bootstrap.

Default model: `google/gemini-3-flash-preview` via OpenRouter. The user can override per session via the settings panel (key + model live in `sessionStorage` only).

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

- `hello.html` and `re-write-able-spec.html` share the same bootstrap structure. Bug fixes and architecture updates to one should be applied to the other.
- Each reference ships with its own `DOC_UUID`. Never reuse a UUID across files. Generate fresh: `node -e 'console.log(crypto.randomUUID())'`.
- The agent's system prompt lives in the bootstrap (`SYSTEM_PROMPT` constant). It must match §6.1 of the spec.
