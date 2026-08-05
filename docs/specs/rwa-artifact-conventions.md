# rwa-artifact conventions (v0.1, draft — 2026-05-12)

Status: draft. Conventions, not a protocol. No version field on disk — the
underlying runtime stays rwa-edit/1.

## What this document is

The runtime spec (`re-write-able-spec.md`) describes a container format and an
editor-first agent. The edit-protocol spec (`rwa-edit-spec.md`) describes the
modify pathway. Both treat the document as text the agent edits.

This document describes the **artifact** dialect of rwa: containers whose
`INLINE_DOC` is heavily interactive and whose primary content is structured
data rendered by inline JavaScript. Documents and artifacts share the same
runtime, the same bootstrap, the same IDB layout, the same lens, the same
export flow. Only the content-shape differs.

An artifact is a container that:

- presents an interactive surface (drop zone, form, list, board, ...)
- stores its data inside the rendered document (the agent reads and edits it)
- delegates extraction / interpretation work to the in-document agent via
  `window.modify(...)`
- protects its UI and behaviour with frozen zones so the agent can't trample
  them

The worked example accompanying this doc is `demo/invoice-tracker.html`:
PDFs are dropped onto a drop zone, the artifact parses them with pdf.js,
asks the agent to extract structured fields, and the agent appends a row to
a table. The .html file is fully self-contained.

## Runtime facts every artifact relies on

These are properties of the existing runtime — not new behaviour. Knowing
them is what makes an artifact possible.

1. **`<script>` tags inside `INLINE_DOC` are executed on every render.**
   `renderDoc()` (seeds/rewritable.html:224–268) wipes `#rwa-doc-mount.innerHTML`
   then walks the new content, re-creating every `<script>` element so it
   actually executes. This means: an IIFE in your artifact runs once at
   bootstrap *and again after every commit*. Design for re-entry.

2. **Form state with stable `id` survives a render.** `renderDoc` captures
   `input/textarea/select/details` values keyed by `id`, then restores them
   after the innerHTML swap. Anonymous inputs don't round-trip. Use `id` on
   any field the user can type into.

3. **The bootstrap exposes a small set of globals** (script-mode `function`
   declarations land on `window`). Artifacts use:
   - `window.submitLens(text)` — routes text through the lens (synthesizes
     default-text / anchored-text envelopes, or runs `/`-prefixed commands
     through `modify()`). **Avoid for artifact-driven calls** — see §4.
   - `window.modify(instruction, lensMeta)` — direct entry to the edit
     pipeline. Bypasses lens anchor state entirely. **Preferred for
     artifact-driven calls.**
   - `window.getDoc()` — returns the current LF-canonical doc text.
   - `RWA` — namespaced runtime constants (`BRIDGE_URL`, `K_API`, ...).

4. **`window.modify` swallows its own errors.** The runtime's catch block
   surfaces failure via the status pill but does not re-throw. To detect
   whether an artifact-initiated call actually committed, observe the DOM
   *after* `await window.modify(...)`: count rows, check for the new
   element, read the status pill (`document.querySelector('button')` with
   text matching `^[✓✗●]`).

5. **Clicking inside the mount is handled — but not the way this said.**
   *Corrected 2026-08-05.* The original text claimed any click on an anchorable
   element (`P, H1-H6, BLOCKQUOTE, LI, FIGURE, PRE, ASIDE`) anchors the lens.
   Since the 2026-06-24 working-block redesign, `handleMountClick` anchors only
   **non-editable containers** — `figure`, `pre`, `aside`, `table`. Clicking a
   paragraph, heading, blockquote or list item now enters **inline
   `contenteditable` editing** instead, and the docked lens the rest of this item
   described was retired outright on 2026-07-07.

   That makes the hazard *worse* than the original "stale anchor highlight, worst
   case" framing in Known Limitations: a stray click inside an artifact can drop a
   caret into live text mid-append rather than merely leaving a highlight. The
   advice is unchanged and now matters more — **artifacts should call
   `window.modify()` directly**, which ignores anchor state, and should avoid
   rendering editable leaf elements they intend to be click targets.

6. **Commits trigger `renderDoc()` which wipes mount state.** Any DOM your
   IIFE built (queue UI, status indicators, ...) vanishes on every
   successful commit. Strategies:
   - State that must outlive a commit: stash on a `window.__<name>`
     namespace and re-render on each IIFE run.
   - Per-action progress UI: accept the wipe. Show a single in-flight
     indicator that disappears when the row arrives.
   - DOM lookups inside long-running async ops: re-query by id each time
     (`document.getElementById(...)`), don't cache at IIFE start.

7. **The runtime's modify mutex serialises edits.** Concurrent calls to
   `window.modify()` throw `concurrent_modify`. Pre-serialise inside your
   artifact (`await` each call before starting the next) so users see clean
   per-item progress instead of mid-batch failures.

## Frozen-zone discipline

Frozen zones are author-declared invariants enforced by the runtime — the
agent's edits are rejected if they overlap. The runtime supports three
comment-fence forms and the `data-rwa-frozen` attribute (see
`rwa-edit-spec.md` §15). For artifacts the convention is:

- `<!-- rwa:frozen:begin app-style -->` ... `<!-- rwa:frozen:end app-style -->`
  wraps the `<style>` block.
- `<!-- rwa:frozen:begin app-dropzone -->` ... `<!-- rwa:frozen:end app-dropzone -->`
  wraps any drop zone, form chrome, or static UI scaffolding.
- `<!-- rwa:frozen:begin app-code -->` ... `<!-- rwa:frozen:end app-code -->`
  wraps the `<script>` block.

Use further `app-*` names for additional zones (e.g. `app-header`,
`app-toolbar`). Distinct names per zone — the runtime requires that
`rwa:frozen:begin <name>` and `rwa:frozen:end <name>` are paired and that
each name appears exactly once.

**Reserved substrings to avoid in agent-edited regions:** `rwa:frozen:begin`,
`rwa:frozen:end`, `<!-- rwa:`, `/* rwa:`, `// rwa:`, `data-rwa-frozen`. For
schema declarations (see below) use a non-reserved prefix like `<!-- app-schema:`.

## Data region: where the agent writes

Every artifact has exactly one (or a small number of) **editable region**
where the agent appends, removes, or modifies items. This region must be:

- Outside any frozen zone.
- Reachable via a **stable string anchor** that survives every prior edit.

The stable-anchor requirement is load-bearing. `apply_edits` operates on
literal byte ranges, so the agent needs a `find` substring that exists in
the current doc state. For an empty data region the first append is easy
("find the empty container, replace with container + first item"), but for
the *N*th append the empty-container pattern no longer exists.

Two patterns work:

1. **Closing-tag anchor**: if the data region is the contents of a unique
   container (e.g. `<tbody id="invoice-rows">`), the closing tag of that
   container is unique in the doc and stable across appends. Tell the
   agent: *"find `</tbody>\n  </table>` and replace by inserting your new
   row before it."*
2. **Sentinel element anchor**: a hidden marker like
   `<tr id="rows-end" hidden></tr>` or `<li class="rows-end" hidden></li>`
   kept as the last child. Tell the agent: *"find the sentinel and prepend
   your new row before it."*

The closing-tag anchor is simpler and works for the table case. The
sentinel approach is more general when the data region isn't a wrapping
element (e.g. siblings in a parent that also has frozen children).

## Schema declarations

Right before the data region, declare the row/item shape in an HTML comment
the agent reads as context:

```html
<!--
  app-schema: each row in <tbody id="invoice-rows"> represents one invoice.
  Columns IN ORDER:
    1) date    YYYY-MM-DD
    2) vendor  the issuing company
    3) total   final amount as printed including currency symbol
    4) items   integer count of distinct line items
    5) source  the original filename
  Use <td class="col-date">, <td class="col-vendor">, etc.
-->
```

The agent receives the full document text on each call; a clear schema
comment near the data region is the most reliable place to put per-row
guidance. The comment uses an `app-schema:` prefix (not `rwa:`) so it
remains agent-editable in principle, though the conventions discourage
edits to schema comments — treat them as authoritative.

## Calling the agent: prompt shape

Artifact-initiated calls go through `window.modify(instruction, lensMeta)`.
Two pieces matter:

```js
await window.modify(buildInstruction(file.name, extractedText), {
  surface: 'artifact:<short-name>',     // names the surface in rwa_hist
  instruction: 'drop ' + file.name,     // short user-facing label for history
  scope: { type: 'document' },
});
```

The `surface` field is free-form (the runtime stores it on the history
record). Use `artifact:<short-name>` so audit logs distinguish artifact
calls from lens calls.

The `instruction` argument is the **full text the agent sees**. The
artifact should explicitly:

1. State the action ("Append one row to ...").
2. List the fields to extract and where each goes (column class, cell
   order, formatting expectations).
3. Tell the agent the **exact anchor strategy** for `apply_edits` (see
   §Data region above). Spelling out the literal `find` shape avoids
   ambiguity on repeated calls — the agent doesn't have to invent it.
4. Forbid changes outside the data region ("Do not modify any other row,
   the &lt;thead&gt;, or any element outside that tbody. Do not touch any
   frozen zone.").
5. Provide a fallback for unextractable fields ("If a field cannot be
   confidently extracted, use the literal string \"?\".") — avoids
   hallucinated values.
6. End with the raw input (extracted text, user description, etc.) inside
   a triple-quoted block.

## CSS conventions

The bootstrap declares a small light-theme palette via custom properties.
Artifacts should use them rather than hard-coded colours:

> **Corrected 2026-08-05.** This section described the pre-redesign visual system: a warm-cream
> background, a terracotta accent, and DM Sans / DM Mono / Instrument Serif as "already wired in the
> bootstrap chrome". None of that is true. The seed was redesigned to a **neutral grayscale palette
> with system fonts** (modelled on playground.ikangai.com), and the strings `DM Sans`, `DM Mono`,
> `Instrument Serif`, `terracotta` and `warm cream` appear nowhere in it. The legacy variable *names*
> below still resolve — they are aliases onto the grayscale ramp, so nothing breaks — but an author
> following the old descriptions was designing against a system that no longer exists, and one
> reaching for those font families was getting whatever the browser substituted.

The bootstrap declares a neutral grayscale ramp, `--gray-50` … `--gray-900`, plus semantic accents.
Legacy aliases resolve onto the ramp and remain safe to use:

| Variable | Use |
|---|---|
| `--gray-50` … `--gray-900` | the grayscale ramp — the primary vocabulary |
| `--bg` | page background (alias — resolves to `--white`) |
| `--surf` | surface / card background |
| `--b1` `--b2` | borders (light, strong) |
| `--text` | primary text |
| `--muted` | secondary text |
| `--accent` | primary action colour (alias — resolves to `--gray-900`, **not** a warm accent) |
| `--blue` | informational accent |
| `--green` `--yellow` `--red` | success / warning / error accents |

**Fonts: system stack only.** `--font-ui` and `--font-mono`. There are no web fonts, no `@import`,
and no named display face — the earlier claim that three families were "already wired in" was the
most actionable error in this document, because it reads as permission to use them.

## External dependencies

Same rules as documents:

- No build step. No npm. No React/Vue/Svelte.
- CDN libraries from cdnjs only, with pinned versions and SRI hashes
  where the loader supports it.
- **Dynamic ESM imports are NOT covered by `<script integrity=>`.** If
  your artifact imports an ESM module at runtime (e.g. pdf.js), be aware
  that a cdnjs compromise at use-time would execute attacker code. For
  high-trust deployments, inline the module bytes (base64 + data URL) or
  serve from same origin.

## Reserved namespaces (recap)

Artifacts must not use these — runtime owns them:

- IDB databases: `rwa_<DOC_UUID>`, `rwa_shared`
- IDB stores in `rwa_<DOC_UUID>`: anything matching `rwa_*`
- HTML id: `#rwa-doc-mount`
- HTML attribute: `data-rwa-frozen` (declaration is allowed; just don't
  reuse the literal name for unrelated attributes)
- Comment / source substrings: `<!-- rwa:`, `/* rwa:`, `// rwa:`,
  `rwa:frozen:begin`, `rwa:frozen:end`
- Surface names used by the lens runtime: `default-text`,
  `default-command`, `anchored-text`, `anchored-command`. Pick
  `artifact:<short-name>` for your surface.

Artifact-defined IDB stores (if any) should be prefixed `app_*` to
prevent collisions with future runtime stores.

## Skeleton for a new artifact

Use this skeleton as a starting point. The four substitution points are
the artifact name, the editable region, the schema, and the agent prompt
builder.

```html
<!-- rwa:frozen:begin app-style -->
<style>
  body{background:var(--bg);color:var(--text);font-family:'DM Sans',system-ui,sans-serif;margin:0;}
  .app{max-width:980px;margin:0 auto;padding:48px 24px 200px;}
  .app h1{font-family:'Instrument Serif',serif;font-style:italic;font-size:54px;line-height:1;margin:0 0 8px;}
  /* artifact-specific styles below */
</style>
<!-- rwa:frozen:end app-style -->

<div class="app">
  <header>
    <h1>{{ artifact title }}</h1>
    <p class="lede">{{ short description }}</p>
  </header>

  <!-- rwa:frozen:begin app-ui -->
  <section id="app-input">
    {{ static UI: drop zone, form, buttons — anything the agent shouldn't touch }}
  </section>
  <!-- rwa:frozen:end app-ui -->

  <!--
    app-schema: {{ describe the editable region's row/item shape }}
  -->
  {{ editable container, e.g. <table id="..."><tbody id="..."> }}
</div>

<!-- rwa:frozen:begin app-code -->
<script>
(function () {
  'use strict';
  // State that must outlive renderDoc() lives here:
  const NS = (window.__appState = window.__appState || { /* ... */ });

  function el(id) { return document.getElementById(id); }

  function buildInstruction(/* args */) {
    return (
      'Append one row to <tbody id="...">. ' +
      'Extract these fields and place them in <td> cells IN ORDER:\n' +
      '  1. field-A — description; class="col-a"\n' +
      '  ...\n' +
      'APPLY_EDITS GUIDANCE: anchor on "</tbody>\\n  </table>" (unique in ' +
      'the document) and insert your new <tr> before it.\n' +
      'Do not modify any element outside that tbody. ' +
      'Do not touch frozen zones (app-style, app-ui, app-code).\n\n' +
      'Input:\n"""\n' + /* ... */ + '\n"""'
    );
  }

  async function processOne(/* args */) {
    const before = document.querySelectorAll('#editable-region > *').length;
    await window.modify(buildInstruction(/* ... */), {
      surface: 'artifact:{{short-name}}',
      instruction: '{{short label}}',
      scope: { type: 'document' },
    });
    const after = document.querySelectorAll('#editable-region > *').length;
    if (after <= before) throw new Error('agent did not add an item');
  }

  // Re-attach listeners each render. Old listeners on detached elements
  // die with them; new ones bind to the freshly rendered DOM.
  const inputEl = el('...');
  if (!inputEl) return;
  inputEl.addEventListener(/* ... */);
})();
</script>
<!-- rwa:frozen:end app-code -->
```

## Compose helper

`tools/compose-artifact.mjs` splices an INLINE_DOC body file into the
canonical seed and writes a new container. Usage:

```bash
node tools/compose-artifact.mjs \
  seeds/rewritable.html \
  /path/to/body.html \
  $(node -e 'console.log(crypto.randomUUID())') \
  my-artifact.html \
  demo/my-artifact.html
```

The script applies the runtime's `escapeTL` to the body before embedding
(escaping `\`, `` ` ``, `${`, `</script`), substitutes `DOC_UUID` and
`RWA.FILE`, and produces a self-contained `.html` ready to open.

The future `rwa new artifact "<description>"` CLI verb wraps this: prompt a
model with these conventions + the user description, capture the produced
body, and run the composer.

## Known limitations

- **Multi-byte UTF-8 in claude -p bridge output.** Characters like `€`,
  `…`, and em-dashes come back as U+FFFD replacement characters when the
  agent is invoked via `claude -p`. This is a CLI / stdout encoding
  problem downstream of the artifact, not an artifact bug. Workaround
  until fixed: instruct the agent to use ASCII fallbacks ("EUR" for €,
  "..." for …) — at a fidelity cost. The OpenRouter backend doesn't
  exhibit this.
- **Click-to-anchor on artifact text.** Any unfrozen `<p>`, heading,
  blockquote, or list item inside the data region is anchorable. If the
  user clicks one and then drops a file, the anchor is stale but doesn't
  affect `window.modify()` calls (they ignore anchor state). Worst case:
  the lens shows a stale anchor highlight until the next render.
- **Single-table-per-artifact assumption.** The closing-tag anchor
  pattern relies on `</tbody>` being unique. Multi-table artifacts need a
  more specific anchor (e.g. `</tbody>\n  </table><!-- invoices end -->`
  with an author-provided marker).

## Worked example

See `demo/invoice-tracker.html`. Drop any PDF invoice onto the drop zone
(or click "choose files…"). The artifact extracts text with pdf.js,
asks the agent to extract date / vendor / total / items / source, and
appends a row to the `<tbody id="invoice-rows">`.

To regenerate after editing the body fragment:

```bash
node tools/compose-artifact.mjs \
  seeds/rewritable.html \
  /tmp/invoice-tracker-body.html \
  4ef74689-e797-4504-9074-e5ee3b86c263 \
  invoice-tracker.html \
  demo/invoice-tracker.html
```

Spec version 0.1 — initial conventions draft. Documents the artifact dialect
of rwa-edit/1 based on the worked invoice-tracker example. No protocol
changes; the runtime stays at rwa-edit/1 + rwa-edit-dsl/1 + rwa-lens/1.
