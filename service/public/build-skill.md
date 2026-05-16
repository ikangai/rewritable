---
name: rewritable
description: Build a self-modifying, self-contained HTML container per the ikangai/rewritable spec (rwa, document-centric architecture). Use when the user asks to produce a "rewritable", "rwa container", "self-modifying HTML", a doc that rewrites itself with ⌘K, or a single-file app that commits its own state on ⌘S. Hands back one .html file that hydrates IndexedDB on first open, lets the user modify the document via OpenRouter, and commits in place via File System Access on Chromium (download fallback elsewhere). Do NOT use this skill for SaaS dashboards, multi-page sites, server-backed apps, login-gated tools, or anything that needs anything other than a single .html file the user opens locally.
---

# rewritable (rwa) — building self-modifying HTML containers

## What this skill produces

One file. A `.html` file the user opens directly from their filesystem. The file boots, renders a user-authored **document**, and lets the user say "make it look like X" or "add a kanban board" — the runtime ships the document to OpenRouter, gets a modified document back, and re-renders. ⌘S writes the new state back to the same `.html` (Chromium with FSA permission) or downloads a new copy of the file (everywhere else).

The user gets back a working container. They can keep modifying it, share it, archive it. It needs no server, no build step, no internet for everything except the modify call.

## Three-layer vocabulary (use these terms consistently)

| Term | What it means |
|---|---|
| **container** | The `.html` file as a whole — what the user opens, shares, archives. |
| **bootstrap** | The immutable shell inside the container: loader + runtime + INLINE_DOC snapshot. Provided by this skill. **Never modified by the agent.** Never written by the document author. |
| **document** | The user-authored part: HTML, CSS, JS, plus any data the user owns. The agent rewrites the document on every ⌘K. The document calls `window.runtime.*` for storage. |
| **snapshot** | The frozen JSON payload embedded in the container, holding the document's HTML/CSS/JS plus its IndexedDB state plus its OPFS files. Hydrated into IndexedDB on first open. Rewritten on every commit. |
| **rwa** | The short name and namespace prefix. All reserved IndexedDB stores start with `rwa_`. The reserved OPFS path prefix is `_rwa/`. |

If you find yourself writing "the rewritable" instead of "the container", or "the app" instead of "the document", stop and re-read this section. The vocabulary is the architecture.

## Components directory layout

You author a components directory. The build script wraps it in a bootstrap and produces the container.

```
my-tracker/
├── meta.json          (required)  title, description, IndexedDB schema declarations
├── document.html      (required)  body fragment — innerHTML for #rwa-render-root
├── document.css       (optional)  document styles — appended after base styles
├── document.js        (optional)  document script — runs after each render
├── data.json          (optional)  initial IndexedDB records keyed by store name
└── files/             (optional)  initial OPFS files (any binary, copied as-is)
```

`meta.json`:

```json
{
  "title": "Project Tracker",
  "description": "Kanban-style task board",
  "stores": {
    "tasks":    { "keyPath": "id", "autoIncrement": true,
                  "indexes": [{ "name": "status", "keyPath": "status" }] },
    "settings": { "keyPath": "id" }
  }
}
```

`document.html` is a body fragment — no `<html>`, `<head>`, or `<body>` tags. The bootstrap wraps it.

`document.js` calls `window.runtime.db.*` and `window.runtime.fs.*` for storage. **The document does NOT implement `getExportData` or `hydrate`** — the runtime owns serialization. The document never writes localStorage (it doesn't exist anymore). The document never touches reserved stores (`rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_meta`) or the reserved OPFS prefix (`_rwa/`).

`data.json` keys must match stores declared in `meta.stores`:

```json
{
  "tasks":    [{ "id": 1, "title": "Wireframe v1", "status": "doing" }],
  "settings": [{ "id": "theme", "value": "dark" }]
}
```

## Build command

```
python3 scripts/build_container.py <components_dir> --output <path/to/output.html>
```

The output is a single self-contained `.html` file. Test by opening it directly in Chrome — F12 console should show no errors and the document should render.

## How the container behaves at runtime (so the document author can rely on this)

1. **First open.** Bootstrap parses, opens IndexedDB. `rwa_doc` is empty → bootstrap reads `<script id="rwa-snapshot">`, creates reserved stores, creates user stores per declared schema, writes records from `data.json`, writes initial OPFS files. Then renders.
2. **Render.** Bootstrap reads `rwa_doc` from IndexedDB, writes `document.css` into a `<style id="rwa-doc-style">`, sets `#rwa-render-root.innerHTML = document.html`, executes `document.js` in a fresh `<script id="rwa-doc-script">`. Document JS now has access to `window.runtime`.
3. **Subsequent opens.** Same path, except the snapshot is ignored — IndexedDB already has the latest state. Snapshot only matters on first open and on commit.
4. **⌘K (modify).** User types instruction. Bootstrap reads `rwa_doc`, ships `{html, css, js}` to OpenRouter (Sonnet 4 default) plus the system prompt explaining the runtime API. Agent returns modified `{html, css, js}`. Bootstrap pushes prior to `rwa_undo` (capped at 10), records instruction in `rwa_hist` (capped at 15), writes new `rwa_doc`, marks dirty, re-renders. **The agent never sees the bootstrap, never sees user data, never sees the runtime code.**
5. **⌘Z (undo).** Pop most recent from `rwa_undo`, write to `rwa_doc`, re-render.
6. **⌘S (commit).** Bootstrap collects current `rwa_doc` + all non-reserved IndexedDB stores + all non-reserved OPFS files into a fresh snapshot. Builds a new container HTML with that snapshot embedded. If a File System Access handle is persisted, writes in place. Otherwise downloads. Both paths mark clean.

## Hard rules

These rules are why the architecture works. Do not relax them.

1. **Never modify `assets/bootstrap.js`** when authoring a document. It is the runtime; it is shared infrastructure across all containers. If you think you need to modify the bootstrap, you are working at the wrong layer — the change belongs in `document.js`.
2. **Never use `localStorage`.** It is not part of the architecture. Use `runtime.db.*` (IndexedDB) for structured state and `runtime.fs.*` (OPFS) for blobs.
3. **Never read or write reserved stores from the document.** `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_meta`, and any name starting with `rwa_` belong to the bootstrap. Same for the OPFS prefix `_rwa/`.
4. **Never put `<html>`, `<head>`, or `<body>` tags in `document.html`.** It is a body fragment. The bootstrap wraps it.
5. **Never define `getExportData` or `hydrate` in `document.js`.** The runtime owns serialization. (This is the biggest difference from earlier versions of this skill — if you remember those hooks, forget them.)
6. **Document JS must be idempotent.** It runs on every render — first open, post-modify, post-undo, post-reset. Use `runtime.db.*` rather than module-scoped variables for state. If you attach event listeners to elements inside `#rwa-render-root`, that's fine — they are torn down with the innerHTML.
7. **Single-file principle.** The container must be standalone. CDN imports allowed only from `cdnjs.cloudflare.com` (where the bootstrap already loads fonts). No npm, no bundlers, no build step beyond the one in this skill.
8. **No frameworks.** Plain HTML/CSS/JS. The agent's context is the document; frameworks balloon it and slow modifies. Tailwind utility classes inline are fine; React is not.
9. **The container must work when opened from `file://`.** Local-first is a hard requirement. The null-origin composition layer depends on it.

## Reserved namespaces (memorize)

| Namespace | Reserved for | Used by |
|---|---|---|
| IndexedDB store name `rwa_doc` | live document content | runtime |
| IndexedDB store name `rwa_undo` | undo stack (≤10) | runtime |
| IndexedDB store name `rwa_hist` | prompt history (≤15) | runtime |
| IndexedDB store name `rwa_meta` | dirty flag, FSA handle, runtime metadata | runtime |
| Any IndexedDB store name starting with `rwa_` | future runtime use | runtime |
| OPFS path prefix `_rwa/` | runtime files | runtime |
| sessionStorage keys `rwa_apikey`, `rwa_model` | OpenRouter credentials | runtime |
| Element IDs `rwa-*` (`rwa-render-root`, `rwa-pal`, `rwa-pill`, etc.) | runtime UI | runtime |
| CSS class prefix `rwa-` | runtime UI | runtime |

## Workflow when a user asks for a rewritable

1. **Read `references/spec-summary.md`** if you need a refresher on the architecture.
2. **Read `references/runtime-api.md`** before writing any `document.js` — it documents every method on `window.runtime.*` with examples.
3. **Look at the visual reference** at `assets/reference/re-write-able-spec.html` if the user wants the published spec page's look (long-form essay layout with the dark theme).
4. **Plan the document.** Decide what stores it needs, what `document.html` looks like, what `document.js` does. Stores go in `meta.json`. Initial records go in `data.json`. Keep it small — the document is what the agent sees on every modify.
5. **Author the components directory.** Use the design tokens already in `base-styles.css` (`--bg`, `--surf`, `--text`, `--accent`, `--blue`, `--red`, `--warn`, etc.). Reach for `'DM Sans'` for UI, `'DM Mono'` for labels and code, `'Instrument Serif'` for display.
6. **Build the container** with `scripts/build_container.py`.
7. **Smoke-test it.** Open the output `.html` in a browser. Verify the document renders without console errors. If you have an OpenRouter key handy, try a small modify to confirm the round-trip works. (Don't ship this step in a code-execution sandbox without internet — but verify the document renders standalone.)
8. **Hand the container to the user via `present_files`.** Tell them: "Open in Chrome, click the ⌘K pill (bottom-right) to set your OpenRouter API key in settings, then ⌘K to modify, ⌘S to save, ⌘Z to undo."

## When NOT to use this skill

- The user wants a server-side app, a SaaS, multi-page navigation, real-time collaboration, or anything that needs more than one HTML file.
- The user wants the AI modify loop to use a model other than via OpenRouter, or wants to bring their own LLM provider directly. (Possible to extend, but out of scope for the skill's defaults.)
- The user wants the document to persist across devices automatically. The container *is* the cross-device persistence — they share the file. There is no cloud.
- The user is on iOS Safari and needs guaranteed durability. iOS Safari aggressively evicts IndexedDB and OPFS; the committed file is the only durable store. This is a noted limitation, not a skill bug.

## Known limitations to surface to the user

- **iOS Safari** evicts IndexedDB and OPFS aggressively. ⌘S export is the only durable store on iOS — encourage users to commit often.
- **FSA in-place commit is Chromium-only.** Firefox and Safari fall back to download-as-new-file. This is by design.
- **First-render flash** is brief but real — the bootstrap loads from disk, opens IndexedDB asynchronously, then renders. For 50–100 KB documents it is imperceptible.
- **Multi-tab is not coordinated.** Two tabs of the same container can step on each other. Last write wins; with FSA, two tabs writing to the same handle can corrupt the file. Treat the container as single-tab.
- **Agent context grows with document size.** The runtime is no longer in the prompt (that's why it lives in the bootstrap), so context is just the document. Past ~200 KB, modify latency and OpenRouter cost climb.
