---
name: rewritable
description: Build a self-modifying, self-contained HTML container per the ikangai/rewritable spec (re-write-able v0.10, rwa-edit/1, rwa-lens/1). Use when the user asks to produce a "rewritable", "rwa container", "self-modifying HTML", a doc that rewrites itself with ⌘K, or a single-file app that commits its own state on ⌘S. Hands back one .html file the user opens locally. It boots, renders a document, lets the user say "make it look like X" through a docked input (the lens), and commits in place on Chromium via the File System Access API (download fallback elsewhere). Do NOT use for SaaS dashboards, multi-page sites, server-backed apps, login-gated tools, or anything that needs more than a single .html file.
---

# rewritable (rwa) — building self-modifying HTML containers

This skill targets **container spec v0.10** (`re-write-able-spec.md`), with the
edit protocol from `rwa-edit-spec.md` v1.4 and the lens edit model from
`rwa-lens-spec.md` v0.9. The defining v0.10 change versus prior versions:
`window.runtime` is now a public contract. Documents can declare their own
IndexedDB stores, persist blobs to a per-container OPFS namespace, drive the
modify loop programmatically, and observe state — all without touching the
runtime.

## What this skill produces

One file. A `.html` the user opens directly from disk. It boots, renders a
**document** inside `#rwa-doc-mount`, and surfaces a docked **lens** (the input
at the bottom of the viewport). The user types into the lens and the runtime
ships the document to OpenRouter; the model returns surgical edits via
`apply_edits` / `apply_dsl_plan` / `replace_document` tool calls. ⌘S writes the
new state back to the same `.html` (Chromium with FSA permission) or downloads
a new copy (everywhere else). The container needs no server, no build step, no
internet for anything except the modify call.

## Vocabulary (use these terms consistently)

| Term | What it means |
|---|---|
| **container** | The `.html` file as a whole — what the user opens, shares, archives. |
| **bootstrap** | The immutable shell inside the container: loader + runtime + system prompt + tool schemas + the per-container `DOC_UUID`. **You never modify it.** Authors never modify it. |
| **DOC_UUID** | A per-container identifier baked into the bootstrap. Names the container's private IndexedDB (`rwa_<DOC_UUID>`) and OPFS namespace (`_<DOC_UUID>/`). Byte-identical from creation through every commit. |
| **document** | The user-facing part: the HTML body fragment (plus inline `<style>` and `<script>`) that lives in the `INLINE_DOC` template literal. **This is the only part you write.** The runtime hydrates it into `#rwa-doc-mount` on every open and re-renders it after every edit. |
| **INLINE_DOC** | The backticked template-literal string in the bootstrap that holds the document. The runtime owns its boundaries; you own its contents. |
| **runtime** | `window.runtime.*` — the public API the document can call to persist data, drive the modify loop, and observe state. |
| **lens** | The docked input at `bottom:24px`, max-width 680px. Two states: default (free text → modifies the whole document) and anchored (after clicking a block → modifies that block). A leading `/` switches to command mode. The lens is part of the bootstrap. Documents leave room for it. |
| **frozen zone** | An author-declared invariant the runtime enforces. Marked with `<!-- rwa:frozen:begin <name> -->` / `<!-- rwa:frozen:end <name> -->` or `data-rwa-frozen` on a single element. The edit-time model is told these are off-limits; any edit overlapping them is rejected. |
| **artifact** | A document whose primary content is interactive (drop zone, form, board), driven by inline `<script>` calling `window.runtime.*`. Same runtime, same bootstrap — only the content shape differs. |

If you find yourself writing "the rewritable" instead of "the container", or
"the app" instead of "the document", stop. The vocabulary is the architecture.

## How to create a container (the whole flow)

```
1. curl https://rewritable.ikangai.com/rewritable.html > out.html
2. Replace the body of the INLINE_DOC template literal in out.html.
3. Hand out.html to the user.
```

That is the whole build. There is no Python step, no components directory, no
`meta.json`, no `data.json`. The seed you fetched from `/rewritable.html`
already contains every byte of the runtime — yours just changes the document.

### Step 1: fetch a fresh container

`GET https://rewritable.ikangai.com/rewritable.html` returns the canonical seed
with a freshly-substituted `DOC_UUID` (the service replaces it on every
request). `Content-Type: text/html; charset=utf-8`. No auth, no rate limit on
this endpoint. The bytes are around 130 KB.

`/new` is a different URL — it's the user-facing download trigger page, not the
container. Always fetch `/rewritable.html` directly.

### Step 2: replace the INLINE_DOC body

Find this region in the fetched file:

```js
const INLINE_DOC = `<style>
  /* …default seed document… */
</style>
<div class="hello">
  <h1>Hello, world.</h1>
  <p>…</p>
</div>`;
```

Replace everything between the opening and closing backticks with your document.
Walk forward from the opening backtick honoring backslash escapes: when you see
`\`, skip the next byte; the first un-escaped backtick is the close. The
default seed body contains no internal backticks, but your replacement may.

**Apply these four escapes to your document body before splicing**, in this
order:

1. `\` → `\\`
2. `` ` `` → `` \` ``
3. `${` → `\${`
4. `</script` (any case) → `<\/script`

Without these, the template literal either terminates early (backtick) or
substitutes a variable (`${`) or gets cut by the HTML parser (`</script`).

Use LF line endings. The runtime canonicalizes on read, but it's friendlier to
emit LF directly.

You may *optionally* also substitute the `<title>` element and the `RWA.FILE`
constant if the user named the file. These are presentation only and don't
affect correctness.

### Step 3: hand it back

Save the modified bytes as `<some-name>.html`. The user opens it in a browser.
Chrome / Edge / Brave / Arc work fully (with File System Access write-in-place).
Firefox and Safari render and modify, but commit downloads a new file.

## The INLINE_DOC body — what to write

The body lands directly in `#rwa-doc-mount.innerHTML`. It is **not** a full
HTML document — no `<html>`, `<head>`, or `<body>` tags. It is the **content
of a `<div>`** the runtime owns.

The body may contain:

- Any HTML (paragraphs, headings, sections, divs, tables, lists, forms, …).
- One or more inline `<style>` blocks. They take effect via normal DOM.
- One or more inline `<script>` blocks. **The runtime clones and re-executes
  every `<script>` on every render** (first open, post-edit, post-undo,
  post-commit). Scripts must be idempotent. Don't `setInterval`
  unconditionally; either gate with a flag on `window`, or accept that a fresh
  interval is fine each render (the old DOM is gone).
- References to design tokens defined by the bootstrap (see Design tokens
  below) — `var(--gray-900)`, `var(--font-ui)`, etc.

Form state with a stable `id` (input, textarea, select, details) round-trips
across renders — the runtime captures values before swapping innerHTML and
restores them after. Anonymous inputs lose state on every render.

## The window.runtime API (v0.10)

`window.runtime` is the public contract for document JS. Available on every
container that boots cleanly (private/incognito mode short-circuits without
setting it; check `typeof window.runtime === 'undefined'` and message the user
clearly).

```js
runtime.id;                                  // string — this container's DOC_UUID

// Per-container IndexedDB. Reserved names (^rwa_) throw RwaReservedError.
await runtime.db.open(name, { autoIncrement }); // declare a store; idempotent
await runtime.db.get(store, key);
await runtime.db.put(store, key, value);        // autoIncrement: pass null/undefined for key
await runtime.db.del(store, key);
await runtime.db.all(store);                    // → [{key, value}, …]
const unsub = runtime.db.subscribe(store, ev => { /* {kind:'put'|'del', key} */ });

// Per-container OPFS, auto-namespaced under _<DOC_UUID>/.
// SECURITY: throws under file:// in Chromium — fall back to db.* for blobs.
await runtime.fs.write(path, blob);
await runtime.fs.read(path);                    // → Blob
await runtime.fs.del(path, { recursive: true });
await runtime.fs.list(prefix);                  // → [{name, kind:'file'|'directory'}, …]

// Drive the modify loop from inside the document (the artifact pattern).
await runtime.modify(instruction, { surface, instruction, scope }); // ⌘K
await runtime.commit();                                              // ⌘S
await runtime.undo();                                                // ⌘Z

// Observe state.
runtime.status;                              // { dirty, fsa, storage: {usage, quota} }
const unsub = runtime.on('modify', () => {}); // events: 'modify' | 'commit' | 'status'
```

`runtime.status.fsa` is one of `unsupported` / `prompt` / `granted` /
`denied` / `lost`. `runtime.status.storage` is captured at boot and refreshed
on each commit/modify.

`runtime.shared.*` (cross-container composition) is **not shipped in v0.10**.
Do not use it. Tracked in spec §11.5.

## Reserved namespaces (do not introduce in your INLINE_DOC body)

| Namespace | Reserved for |
|---|---|
| Element ID `#rwa-doc-mount` and any `#rwa-*` | Runtime mount + chrome |
| CSS class `rwa-locked` and any `rwa-*` | Runtime UI / lock affordance |
| Attribute `data-rwa-id` | Runtime-assigned stable block ID — see below |
| Attribute `data-rwa-frozen` | Frozen-zone declaration — see below |
| Source substrings `rwa:frozen:begin`, `rwa:frozen:end`, `<!-- rwa:`, `/* rwa:`, `// rwa:` | Frozen-zone markers and runtime comments |
| IDB DB names `rwa_<DOC_UUID>`, `rwa_shared` | Runtime DBs |
| IDB store names matching `^rwa_` | Runtime stores (throw `RwaReservedError`) |
| OPFS path prefix `_rwa/` | Runtime files |
| sessionStorage keys `rwa_apikey`, `rwa_model` | OpenRouter credentials |
| BroadcastChannel names `rwa_<DOC_UUID>:<store>` | Runtime pub/sub |

Document-defined IDB stores should use the `app_` prefix
(`app_tasks`, `app_settings`) to stay clear of any future reserved name.

## data-rwa-id — leave it to the runtime

The runtime assigns `data-rwa-id="<8 lower-base32 chars>"` to every anchorable
block (`<p>`, `<h1>`–`<h6>`, `<blockquote>`, `<li>`, `<figure>`, `<pre>`,
`<aside>`) at bootstrap and at every commit. They're the stable name of each
block; URL fragments link to them.

**Don't emit `data-rwa-id` attributes in your INLINE_DOC body.** Let the
runtime backfill on first open. The edit-time model is instructed to preserve
existing values verbatim — if you invent them, you risk duplicate IDs.

## Frozen zones — when to add them

Default: don't. The seed ships with no frozen zones; pure-prose documents
should keep that property. The user can always edit the `.html` file directly
to add a zone later.

Add zones when the document is **interactive** (an artifact) and parts of it
must not be rewritten by the agent:

```html
<!-- rwa:frozen:begin app-style -->
<style>/* app styling — agent must not touch */</style>
<!-- rwa:frozen:end app-style -->

<!-- rwa:frozen:begin app-ui -->
<section id="app-input">…drop zone, form, buttons…</section>
<!-- rwa:frozen:end app-ui -->

<!-- rwa:frozen:begin app-code -->
<script>(function(){ /* artifact JS */ })();</script>
<!-- rwa:frozen:end app-code -->
```

Single-element shorthand: add `data-rwa-frozen` to a `<script>` or `<style>`.

Conventions:

- Use distinct names: `app-style`, `app-ui`, `app-code`, `app-header`, …
- Each name appears exactly once as `begin` and once as `end` (the runtime
  enforces pairing).
- Leave the **data region** (where the agent appends/edits items) **outside**
  any frozen zone — agents need to be able to edit there.

## Design for editability (the anchor-friendliness rule)

The edit-time model uses `apply_edits` — anchor-based string substitution. Each
edit needs a `find` substring that's **unique** in the document. Documents that
defeat uniqueness defeat editability.

**Do:**

- Use distinctive labels for items the user is likely to edit (`<tr id="invoice-2026-001">`, not `<tr>Invoice</tr>` × 50).
- For repeating data regions, give the container a unique ID (`<tbody id="invoice-rows">`) so the closing tag (`</tbody>\n  </table>`) is a stable anchor for appends.
- For sentinel-anchored regions, drop a hidden marker as the last child: `<tr id="rows-end" hidden></tr>`.
- Document the data shape near the editable region in an HTML comment with an
  `app-schema:` prefix (not `rwa:`) — the model reads it as context.

**Don't:**

- Emit 100 lines of repeated boilerplate (`<p>•</p>` × 100) — anchors collide.
- Lean on `<script>` to generate content at render time when the user expects
  to edit it — the edit-time model sees the source, not the rendered DOM.

## The lens — leave room

The lens is a floating card fixed at `bottom:24px`, max-width 680px, centered.
The bootstrap sets `body { padding-bottom: 160px }` to reserve room. Your
document body **must not** place a fixed/sticky footer or any other UI in the
bottom 160px of the viewport — it'll be obscured. Stay above the reserve.

The lens has two states:

- **default**: typed text becomes "modify the whole document with this".
- **anchored**: after the user clicks an anchorable block, typed text becomes
  "rewrite this block to match this".
- **command mode**: a leading `/` switches to commands (`/undo`, `/redo`,
  `/share`, …). Don't emit `/`-prefixed user-facing text the user might paste
  in expecting it to become content.

## Design tokens

Reach for the bootstrap's CSS custom properties instead of hard-coding colors
or fonts. The full palette:

| Token | Value | Use |
|---|---|---|
| `--white` | `#ffffff` | Pure white |
| `--gray-50`..`--gray-900` | `#fafafa` → `#171717` | 10-step neutral ramp |
| `--green` | `#22c55e` | Success / positive |
| `--yellow` | `#eab308` | Warning |
| `--red` | `#ef4444` | Error / destructive |
| `--blue` | `#3b82f6` | Info |
| `--radius` | `24px` | Default border-radius for surfaces |
| `--radius-sm` | `12px` | Compact border-radius |
| `--bg` | `var(--white)` | Page background |
| `--surf` | `var(--white)` | Surface / card |
| `--b1` | `var(--gray-100)` | Light border |
| `--b2` | `var(--gray-200)` | Strong border |
| `--text` | `var(--gray-900)` | Primary text |
| `--muted` | `var(--gray-500)` | Secondary text |
| `--accent` | `var(--gray-900)` | Accent (action, link) |
| `--font-ui` | `-apple-system, …, sans-serif` | Body / UI text |
| `--font-mono` | `'SF Mono', …, monospace` | Code / labels |

`--bg/--surf/--b1/--b2/--text/--muted/--accent` are legacy aliases over the
gray ramp — both names render the same. No web fonts are loaded; the stack is
system.

## What the edit-time model sees

The user later types into the lens. The runtime ships **only the current
document body** (LF-canonical text inside `#rwa-doc-mount`) plus the list of
frozen-zone names to OpenRouter. The bootstrap, runtime code, system prompt,
and tool schemas stay out of the prompt.

The model has three tools:

- `apply_dsl_plan` — preferred for **structural** transforms (insert/delete
  elements, wrap/unwrap, mass rename, reorder). Compiles deterministically to
  `apply_edits`.
- `apply_edits` — preferred for **content** transforms (prose rewrites, value
  updates, typos, translations). `(find, replace)` pairs with unique anchors.
- `replace_document` — escape hatch. Used only for scaffolding or wholesale
  redesign.

The runtime drives a multi-turn loop with a 3-retry budget per ⌘K. On failure
(`find_not_found`, `find_not_unique`, `frozen_zone_violation`,
`structural_shape_changed`, …) the structured failure is fed back as a
tool_result and the model gets another attempt. After exhaustion the user sees
the failure; **no silent escalation** to `replace_document`.

Default model: `google/gemini-3.5-flash` via OpenRouter. The user
overrides per session in the settings panel (key + model live in
`sessionStorage` only); the model input is pre-populated with a curated
datalist of benchmarked OpenRouter models for autocomplete.

## Hard rules (do not relax)

1. **Never modify the bootstrap.** Only the bytes inside the `INLINE_DOC`
   template literal change. `DOC_UUID`, the loader, the runtime, the system
   prompt, and the tool schemas are byte-identical from creation through every
   commit. This is the load-bearing invariant of the format.
2. **No `<html>`, `<head>`, `<body>` tags in INLINE_DOC.** It's a body fragment;
   the runtime wraps it.
3. **No `localStorage`.** Use `runtime.db.*` for structured state and
   `runtime.fs.*` for blobs.
4. **Never read or write reserved stores from the document.** `rwa_*` IDB
   names, `_rwa/` OPFS paths, `#rwa-*` element IDs. The runtime API throws
   `RwaReservedError` if you try.
5. **Don't use `runtime.shared.*`.** Deferred in v0.10.
6. **Don't define `getExportData` or `hydrate` hooks.** The runtime owns
   serialization. (If you've seen pre-v0.10 versions of this skill mention
   these hooks, forget them.)
7. **Document JS must be idempotent.** It runs on every render.
8. **Single-file principle.** The container is one `.html`. Inline everything.
   CDN imports allowed only from `cdnjs.cloudflare.com` (where the lens chrome
   already lives) and only when genuinely needed.
9. **No frameworks.** Plain HTML/CSS/JS. The agent's context is the document;
   frameworks balloon it and slow modifies. Utility classes inline are fine;
   React is not.
10. **The container must work when opened from `file://`.** Local-first is a
    hard requirement. (Caveat: OPFS is unavailable under `file://` in Chromium;
    `runtime.fs.*` throws a clear message and you fall back to `runtime.db.*`
    with Blob values.)

## Workflow

1. **Read the user's request.** Identify: is this a **document** (pure prose,
   layout-driven, no interactivity) or an **artifact** (interactive, runtime.db
   or runtime.fs in play)?
2. **Plan the document body.** Decide structure (sections, headings, data
   regions), stores (if any), and whether frozen zones are warranted (artifact:
   yes; document: usually no).
3. **Fetch the seed.** `curl https://rewritable.ikangai.com/rewritable.html > out.html`.
4. **Splice in your document.** Locate the `const INLINE_DOC = \`` opening,
   walk forward honoring backslash escapes to find the closing backtick,
   replace the body. Apply the four escapes (`\`, `` ` ``, `${`, `</script`).
   Use LF line endings.
5. **Smoke-check.** Open the file in a browser. The document should render
   without console errors. The lens should dock at the bottom.
6. **Hand back.** "Open in Chrome, click the lens (bottom of screen) to focus
   it, type what you want to change, press Enter. ⌘S to save, ⌘Z to undo. The
   settings dot top-right is where you paste your OpenRouter API key."

## Two minimal examples

### A pure-prose document

```html
<style>
  .essay { max-width: 720px; margin: 64px auto; padding: 0 24px; color: var(--text); font-family: var(--font-ui); font-size: 17px; line-height: 1.65; }
  .essay h1 { font-size: 36px; line-height: 1.15; letter-spacing: -.01em; margin-bottom: 24px; }
  .essay p { margin: 0 0 16px; }
</style>
<article class="essay">
  <h1>On rewriting in place</h1>
  <p>Most documents are write-once. This one is not.</p>
  <p>Type into the input below and the document changes. Save and the change is in the file.</p>
</article>
```

### An artifact using runtime.db

```html
<!-- rwa:frozen:begin app-style -->
<style>
  .tasks { max-width: 560px; margin: 48px auto; padding: 0 24px; font-family: var(--font-ui); color: var(--text); }
  .tasks h1 { font-size: 28px; margin: 0 0 24px; }
  .tasks form { display: flex; gap: 8px; margin-bottom: 16px; }
  .tasks input { flex: 1; padding: 8px 12px; border: 1px solid var(--b2); border-radius: var(--radius-sm); font: inherit; }
  .tasks button { padding: 8px 14px; border: 0; background: var(--gray-900); color: white; border-radius: var(--radius-sm); cursor: pointer; }
  .tasks ul { list-style: none; padding: 0; margin: 0; }
  .tasks li { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--b1); }
  .tasks li.done { color: var(--muted); text-decoration: line-through; }
</style>
<!-- rwa:frozen:end app-style -->

<div class="tasks">
  <h1>Tasks</h1>
  <!-- rwa:frozen:begin app-ui -->
  <form id="task-form">
    <input id="task-input" placeholder="What needs doing?" autocomplete="off">
    <button type="submit">Add</button>
  </form>
  <!-- rwa:frozen:end app-ui -->
  <ul id="task-list"></ul>
</div>

<!-- rwa:frozen:begin app-code -->
<script>
(async function () {
  if (typeof window.runtime === 'undefined') return; // private mode
  await runtime.db.open('app_tasks', { autoIncrement: true });

  const list = document.getElementById('task-list');
  const form = document.getElementById('task-form');
  const input = document.getElementById('task-input');

  async function render() {
    const rows = await runtime.db.all('app_tasks');
    list.innerHTML = rows
      .map(r => `<li data-id="${r.key}" class="${r.value.done ? 'done' : ''}">
        <input type="checkbox" ${r.value.done ? 'checked' : ''}>
        <span>${r.value.text.replace(/[&<]/g, c => c === '&' ? '&amp;' : '&lt;')}</span>
      </li>`)
      .join('');
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    await runtime.db.put('app_tasks', null, { text, done: false });
    input.value = '';
  });

  list.addEventListener('change', async (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    const id = Number(li.dataset.id);
    const row = await runtime.db.get('app_tasks', id);
    await runtime.db.put('app_tasks', id, { ...row, done: e.target.checked });
  });

  runtime.db.subscribe('app_tasks', render);
  render();
})();
</script>
<!-- rwa:frozen:end app-code -->
```

## When NOT to use this skill

- Server-side app, SaaS, multi-page navigation, real-time collaboration, or
  anything that needs more than one HTML file.
- AI modify loop on a non-OpenRouter provider, or the user wants to bring their
  own LLM directly. (Possible to extend; out of scope for the defaults.)
- Cross-device automatic persistence. The container *is* the cross-device
  persistence — the user shares the file. There is no cloud.
- iOS Safari for durable use. iOS Safari aggressively evicts IndexedDB and
  OPFS; the committed `.html` is the only durable store.

## Known limitations to surface to the user

- **iOS Safari eviction.** IndexedDB and OPFS evict aggressively after
  inactivity or storage pressure. Commit often. The exported file is durable;
  the in-browser state is not.
- **FSA in-place commit is Chromium-only.** Firefox and Safari fall back to
  download-as-new-file. By design.
- **OPFS unavailable under `file://` in Chromium.** `navigator.storage.getDirectory()`
  throws `SecurityError`. `runtime.fs.*` catches this and throws a clear
  message. Use `runtime.db.*` with Blob values for blobs under `file://`.
- **Direct OPFS access bypasses isolation.** `runtime.fs.*` namespaces under
  `_<DOC_UUID>/`; a document that calls `navigator.storage.getDirectory()`
  directly is opting out. Don't.
- **Multi-tab is uncoordinated.** Two tabs of the same container can step on
  each other. Last write wins; with FSA, two tabs writing the same handle can
  corrupt the file. Treat the container as single-tab.
- **Quota shared per origin.** Many open containers under `file://` add up to
  one shared budget even though state is namespaced.
- **Agent context grows with document size.** The runtime is in the bootstrap
  (not in the prompt), so context is just the document. Past ~200 KB, modify
  latency and OpenRouter cost climb.
