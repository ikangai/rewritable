# Flagship datatable rewritable — affordance reference consumer

Date: 2026-05-30 · Author: tesla (parallel wave: bohr/euler/newton/tesla)
Status: design → implementation

## Why

The ikangai blog *"A rewritable file should know what it is"* reframes a file's
**type as a registered bundle of affordances** — View / Edit-surface / Tool /
Compute / Hook — served by one portable runtime to both humans and agents.

The team's fresh wave is building the abstraction from three sides:

- **bohr (L1):** affordance-kernel spec / RFC (new doc).
- **euler + newton (L3):** the self-description surface — `runtime.describe()`,
  an embedded `#rwa-manifest`, and `rwa doc`/`describe` reporting the file's kind
  and affordances.

What is missing — and what this lane provides — is a **real, multi-affordance
artifact** to validate those abstractions against. Specs and registries drift
without a reference consumer. This is that consumer: the blog's own flagship
example, a **datatable**, built end-to-end on the substrate as it exists today.

## Key substrate finding

The model-free edit path **already exists** and is **unexercised by any shipped
artifact**:

- `window.runtime.applyEnvelope(envelope, {surface, instruction})`
  (`seeds/rewritable.html:820`, wired at `:4100`) routes a synthesized
  `rwa-edit/1` envelope through `synthesizeAndCommit` — so the modify mutex,
  frozen-zone + structural-shape checks, the undo stack, `rwa_hist`, and runtime
  events all fire exactly as if the edit came from the lens. The `surface` label
  distinguishes client-driven edits (`datatable:cell-edit`) from agent-driven
  ones.
- `window.getCurrentDocCache()` (`:2053`) returns the exact **stored** doc text
  (LF-canonical) — the precise anchor surface `apply_edits` matches against. This
  sidesteps DOM-`textContent` drift: the edit-surface reads the stored text,
  splices the data block, and the `find` is guaranteed to match.

So this lane **proves and hardens** that path rather than adding capability. The
kanban board, the only other direct-manipulation rwa, currently *skips* it
(`board.html` drop handler: "no-op: leave commit to user"), so direct edits there
never enter the audit/undo pipeline. This artifact does it correctly.

## What it is

A single self-contained `.html` (default `document` kind — `PRODUCT_KIND` only
selects a system prompt, irrelevant to a human edit-surface) that renders a small
real dataset (a quarterly line-item budget) as an interactive grid.

Affordances it carries and declares:

| Kind | Instance | Mechanism |
|---|---|---|
| **View** | grid (default) + summary toggle | document JS renders `#dt-data` |
| **Edit-surface** | click a cell → inline input → commit (no model) | `runtime.applyEnvelope`, `surface:"datatable:cell-edit"` |
| **Compute** | `total = qty × unit_price`, grand total | pure derivation at render; never stored |
| **Tool** | agent edits rows by rewriting `#dt-data` | the existing `rwa-edit/1` contract on the JSON block |

Self-description: a `<script type="application/rwa-affordances+json"
id="rwa-affordances">` manifest lists kind + affordances in a forward-compatible
shape, so euler/newton's `describe()`/`#rwa-manifest` surface can read it without
executing JS. Key names to be reconciled with their lane.

## Data flow (the keystone — a cell edit)

```
human clicks cell (r,c)
  → inline <input> (e.stopPropagation so the lens click-to-anchor seam doesn't fire)
  → on Enter/blur:
      doc   = window.getCurrentDocCache()              // exact stored text
      block = extract #dt-data JSON substring from doc // = find anchor (unique)
      rows  = JSON.parse(block); rows[r][col] = value
      next  = serialize(rows)                           // identical formatting
      runtime.applyEnvelope(
        { version:'rwa-edit/1', edits:[{ find: block, replace: next }] },
        { surface:'datatable:cell-edit', instruction:`set ${col} row ${r}` })
  → synthesizeAndCommit → applyEdits → commitDoc (rwa_doc/undo/hist) → renderDoc
  → document JS re-runs, re-reads #dt-data, re-renders grid + recomputes columns
```

Compute columns are derived in the render pass and never written, so they cannot
drift from the source rows. Add-row uses the same envelope path.

## YAGNI — explicitly out of scope for v1

- No **Hook** affordance (lifecycle) — not needed to prove the thesis.
- No registration through `runtime.provide('view', …)` — the seed only activates
  views for `presentation` kind; an in-doc render keeps this seed-free and
  robust. (Stretch: probe whether `provide`/`setView` works for `document` kind.)
- No per-cell surgical anchoring — whole-block `find/replace` is unique and
  trivially correct at demo scale.
- No new product kind in the seed — that's a separate, coordinated seed lane.

## Testing (thorough — the goal demands it)

1. **jsdom** (`tests/datatable.mjs`, modeled on `tests/view.mjs`): load the
   artifact, wait for `runtime`, drive a cell edit through the real
   `applyEnvelope` path, then assert: `rwa_doc` updated; `rwa_hist` newest record
   carries `surface:"datatable:cell-edit"`; the compute column reflects the new
   value; `runtime.undo()` reverts both the cell and the computed total; a
   frozen-zone / shape-violating edit is rejected.
2. **chrome-devtools** smoke: open in a real browser, click-edit a cell, confirm
   visual update + persistence + a screenshot for the "pleasure to use" bar.

## Success criteria

- Opens as one file; a human edits cells with zero model calls; ⌘S persists.
- Every direct edit lands in `rwa_hist` (audited) and is undoable.
- Compute columns are always consistent with rows.
- An agent can read it (`rwa doc`) and edit it (`rwa edit` on `#dt-data`).
- The affordance manifest is readable without executing JS.
- Zero changes to `seeds/rewritable.html` or `cli/` — no collision with the
  parallel seed/CLI lanes.

## Home

`examples/datatable/datatable.html` + `examples/datatable/README.md`
(new tracked dir, distinct from the scratch `demo/` files). Test at
`tests/datatable.mjs`.

---

## Outcome (2026-05-30)

Built and verified. `examples/datatable/{_source.html, build.mjs, datatable.html,
README.md}` + `tests/datatable.mjs` (25/25 jsdom assertions) + a real-browser
Chrome smoke test (real IndexedDB: qty edit persisted, computed total + grand
total recomputed, Summary view re-rendered). Zero changes to `seeds/` or `cli/`.

### Two substrate-consumer bugs surfaced + handled

1. **Edit-surface concurrency.** `synthesizeAndCommit` releases `modifyMutex`
   *after* `renderDoc`, so the DOM/data update is observable before the mutex is
   free. A rapid second direct edit (fast typing) then throws `concurrent_modify`.
   The lens is immune (its UI serializes input); a datatable is not. Fixed in the
   artifact with a window-scoped serialized commit chain (`window.__dtBusy`) +
   bounded retry. **Recommendation:** document this as substrate guidance for any
   interactive rewritable, or expose a `runtime.busy`/queue helper.

2. **Raw `</script` in document scripts.** `escapeForTL` escapes `</script` to
   protect the bootstrap's template literal at file-parse time, but template-literal
   evaluation drops the backslash, so the *runtime* doc text carries a raw
   `</script` — which closes an inner `<script>` when the doc is `innerHTML`'d on
   re-render. Mitigation: never write the contiguous sequence in document JS (use
   `'<' + '/script'`; write regexes as `<\/script`).

### The self-description gap (the keystone finding)

`tools/self-description.mjs --check` already anticipates a `datatable` kind in
`KIND_PROVIDERS`, so it computes `kind: datatable, source: static, affordances:
[view:grid, edit-surface:cell, tool:derive, compute:recalc]` from `PRODUCT_KIND`
alone. But those are **placeholder providers** baked into the kind template — they
disagree with this real artifact's affordances (`view:grid`, `view:summary`,
`edit-surface:cell`, `compute:total`; **no** `tool` — agent edits are the
substrate-universal `edit`, not a type-added tool provider).

This is the concrete proof that **a kind-template cannot capture a specific file's
real affordances** (two views, a named compute). Static-from-kind is a coarse
approximation; live-from-registry can't see them either (the kernel only registers
`view` today). Only a **per-file declaration** — the `#rwa-affordances` block this
artifact carries — is honest. Recommendation to the self-description lane: have the
reader **prefer an embedded declaration when present** (the deferred "stamp",
self-description spec §5), and/or extend `runtime.provide` to `edit-surface` and
`compute` so a datatable can register its real providers live.
