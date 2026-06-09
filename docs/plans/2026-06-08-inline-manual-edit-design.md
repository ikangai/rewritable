# Inline manual edit — direct, no-LLM block editing

**Status:** design approved (brainstormed + verified), implementation in progress on branch `inline-manual-edit`.
**Date:** 2026-06-08.

> **Update (2026-06-09):** this edit surface gained a *prompt-mode* layer — typing `/`
> at the start of an inline edit turns the session into a block-scoped agent command
> (Enter routes to the lens's anchored-command path; Esc demotes to literal text; blur
> discards). The no-LLM direct-text path documented here is unchanged. See
> `docs/plans/2026-06-09-inline-lens-dual-mode-design.md` (design) and
> `docs/plans/2026-06-09-inline-lens-dual-mode-impl.md` (implementation plan).

## Motivation

Today the only way to change or delete an existing block is a **lens slash command**
(`/edit this`, `/delete this`) — which calls the **LLM**. The lens's plain "direct text"
mode is **additive only**: anchored direct text inserts a new block *after* the anchored
one (`synthesizeAnchoredInsert` keeps the original and appends), default direct text
appends at EOF. So a user who just wants to fix a typo, rewrite a sentence, or remove a
block by hand has no path that doesn't go through the model.

This adds **manual, in-place, no-LLM editing**: double-click a block, edit its text by
hand, commit on blur/Enter. It rides the **existing non-agent commit path** — no API key,
works offline, which fits the "exported `.html` is the only durable artifact" ethos. It is
a new direct-manipulation **`edit-surface`** (the same affordance kind the datatable
already uses, actor `user:edit-surface`).

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Editing model | **In-place `contenteditable`** (word-processor feel) |
| Enter gesture | **Double-click** a block to enter edit. Single-click still anchors the lens (unchanged). |
| Enter key | **Enter commits + exits**; **Shift+Enter** inserts one `<br>`; **Esc** cancels + reverts |
| Commit trigger | **Blur** commits; ⌘S commits-then-saves (today's ⌘S); **empty-on-blur deletes** the block |
| Editable scope | **Leaf text blocks only** — the leaf-text members of `ANCHORABLE_TAGS`: `<p>`, `<h1–6>`, `<blockquote>`, `<li>`, `<td>`. (`figcaption` was dropped during build: it is not independently anchorable — it lives inside `FIGURE`, so ordinal resolution can't target it.) Containers/structural blocks and frozen zones are not editable. Paste forced to plain text. |
| Engine | **No LLM.** Commit via `runtimeApplyEnvelope` → `commitCore`, `actor:'user:edit-surface'`. One ⌘Z per edit. |

Deferred (YAGNI): block split/merge (the "Enter splits into a new block" model), rich
inline formatting, multi-cell/table editing beyond a single `<td>`, an explicit edit-mode
toggle (only if double-click proves undiscoverable), CLI surface (manual editing is a
browser-UI gesture; the CLI has no analogue).

## Verified envelope strategy

A focused verification (3 readers + 1 adversarial pass, empirically tested in jsdom)
confirmed the approach and caught two corruption modes the naive version would hit.

**What we reuse (no new apply/validator/commit machinery):**

| Primitive (`seeds/rewritable.html`) | Role |
|---|---|
| `anchorableOrdinal(mount, el)` + `sourceMap[ord]` | clicked DOM node → source-map entry |
| `resolveAnchorFind(entry)` → `{find, replacePrefix, replaceSuffix}` | **unique** anchor (expands through siblings until byte-unique → `find_not_unique` handled for free) |
| `runtimeApplyEnvelope` → `commitCore` | non-agent commit, `actor:'user:edit-surface'`, one undo frame |
| `escapeHtml`, `modifyMutex`, `activeView` gate | escaping, concurrency, view-mode inertness |

**Confirmed facts:**
- `data-rwa-id` is part of the **stored canonical doc text** (injected by
  `injectMissingBlockIds` into the persisted bytes, not a render-only decoration) — so an
  anchor built from a live block matches the stored text.
- The reserved-substring check blocks `data-rwa-frozen` but **allows `data-rwa-id`**.
- A same-tag text-only replace **passes** `computeShape` (no tags added/removed).
- Frozen zones (marker-form via range check, attribute-form via snapshot) are rejected —
  so we simply must not make frozen blocks editable; the guard is the backstop.

### The two corruption modes (and the fix)

Both are fixed by **how we synthesize the replace string** — not by changing the pipeline.

1. **`data-rwa-id` loss → broken fragment links.** The naive path (reuse `wrapDirectText`,
   or emit the live `outerHTML`) drops/relocates the id. On commit, `injectMissingBlockIds`
   assigns a **new random id**, silently breaking every `#id` fragment link and cross-doc
   anchor. **Fix:** read `el.getAttribute('data-rwa-id')` from the live node and re-emit it
   **verbatim** in the replace (exactly what the agent system prompt already mandates).

2. **`contenteditable` HTML-soup → re-render desync.** Even with plain-text paste, a
   `contenteditable` block ends up holding `<div>`/`<br>` (Enter inserts a `<div>` in
   several engines). `<p>a<div>b</div>c</p>` passes **every** guard (reserved, `computeShape`
   — which only looks at `<script>`/`<style>`/top-level types — and tag-balance), is stored
   verbatim, then **reparses on re-render**: the `<div>` hoists out of the `<p>`, orphaning
   text and making `buildSourcePositionMap` (regex, counts `</p>`) disagree with the live
   DOM → sourceMap desync → every later click anchors the **wrong** block. **Fix:** a
   controlled serializer that reads from `childNodes`, emitting **only** escaped text and
   `<br>`, flattening everything else to its `textContent`.

### Synthesis (the one load-bearing new function)

```js
// permit ONLY escaped text + <br>; flatten any other node to plain text
function serializeLeafSafe(el) {
  let out = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3)         out += escapeHtml(n.nodeValue);     // text node
    else if (n.nodeName === 'BR') out += '<br>';                      // soft break (Shift+Enter)
    else                          out += escapeHtml(n.textContent);   // flatten soup
  }
  return out;
}
```

Commit (blur/Enter), with `entry` captured **at edit-start** (never read `el` after the
post-commit re-render). **As-built refinement:** rather than reconstruct `<tag id>` (which
would drop `class`/`style`/other attributes), re-emit the block's **original opening tag
verbatim** sliced from the pristine stored source — preserving `data-rwa-id` *and* every
other attribute, and immune to anything `contenteditable` may have added to the live node
(e.g. the `contenteditable="true"` attribute itself):

```js
const a = resolveAnchorFind(entry);                              // unique {find, prefix, suffix}
const newText = serializeLeafSafe(el);
const orig = currentDocCache.slice(entry.start, entry.end);      // pristine <p class.. id..>old</p>
const openTag = orig.match(/^<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/)[0]; // original open tag, verbatim
const tag = openTag.match(/^<([a-zA-Z][a-zA-Z0-9]*)/)[1];
const replace = newText.trim() === ''
  ? a.replacePrefix + a.replaceSuffix                            // empty → delete the block
  : a.replacePrefix + openTag + newText + `</${tag}>` + a.replaceSuffix;
await runtimeApplyEnvelope(
  { version:'rwa-edit/1', edits:[{ find:a.find, replace, reason:'edit' }] },
  { actor:'user:edit-surface', surface:'inline-edit' });
```

For un-blessed nodes (no `data-rwa-id`) the original open tag simply lacks one; the
commit-time backfill adds it — matching agent behaviour. The id is never user/paste-supplied
(it comes from the stored source), which sidesteps the seed-only `reserved_id_used` check the
CLI mirror lacks.

## Interaction edge cases & error handling (fail-loud, Rule 12)

- **Re-render destroys the node.** Attach `dblclick`/`keydown`/`blur` via **delegation on
  the mount** (survives re-render). Capture `{id, tag, text, entry}` before committing;
  `await` the full commit; if restoring focus, re-resolve by id
  (`mount.querySelector('[data-rwa-id="…"]')`). **Debounce** so the re-render's own blur
  can't re-fire a commit.
- **Concurrency.** Guard commit on `modifyMutex` exactly as `runAnchoredCommand` does — a
  manual edit landing during an agent loop rejects cleanly. Double-click-to-edit is **inert
  under an active view** (`if (activeView) return;`).
- **Delete can be legitimately rejected.** If the deleted block is the *last* of its tag
  type at `<body>` top-level, `computeShape.topLevelTypes` shrinks → `structural_shape_changed`.
  (Common case — nested in `<article>` — is unaffected.) On that error: **restore the
  block's prior text and surface the failure.** Never silently leave an empty block, never
  escalate to `replace_document`.
- **Any `resolveAnchorFind` → null, or any apply error:** hard, visible failure — revert
  the block, show the code. No silent no-op.

## Test plan (`tests/inline-edit.mjs`, jsdom + fake-indexeddb)

Written red→green; each test encodes **why** (Rule 9):
- **id preserved** through replace — a re-assigned id breaks `#id` fragment links.
- **soup flattened** — commit a `<div>`/`<br>` edit, re-render, assert sourceMap stays in
  sync (no desync warning, ordinals still map correctly).
- soft-break `<br>` survives a commit.
- **empty → delete** (incl. the real-browser case where an emptied block holds a lone
  `<br>`); **delete-last-of-type → `structural_shape_changed` surfaced, not silent**.
- **no-change edit commits nothing** (no undo frame / history record burned).
- frozen block (`data-rwa-frozen` attribute form) not made editable; container/non-leaf not
  editable; `<td>` editable.
- attributed to `user:edit-surface`; Enter commits / Esc reverts / blur commits /
  Shift+Enter does not commit.

Covered elsewhere (not duplicated in `tests/inline-edit.mjs`):
- **inert under active view** — `tests/view.mjs` (the only harness with a registered view);
  the `dblclick` handler is gated on `!activeView` in `renderDoc`, next to click-to-anchor.
- **concurrency** — inherited from `runtimeApplyEnvelope`/`commitCore` (serializes vs
  non-agent, rejects `concurrent_modify` vs an agent loop): `tests/r5-concurrent-commit.mjs`
  + `tests/write-path.mjs`.

Possible follow-up: an `INLINE-EDIT-0x` conformance family in `benchmark/`.

## Implementation steps (ordered)

1. **(this doc)** design + commit on branch `inline-manual-edit`.
2. `tests/inline-edit.mjs` — RED on the two corruption modes first, then the rest.
3. `seeds/rewritable.html` — `serializeLeafSafe`, mount-delegated `dblclick`/`keydown`/
   `blur` handlers, `commitInlineEdit`, gates (frozen / view / mutex). GREEN.
4. Full `tests/` suite — confirm zero regressions (e2e/lens/write-path/region-commit/
   commit-sink/view/datatable/skin-compose).
5. `docs/specs/rwa-lens-spec.md` — note the single-click(anchor)/double-click(edit) boundary;
   `CLAUDE.md` routing if needed.
6. Checkpoint → `superpowers:requesting-code-review`. Do **not** merge to `main` without
   user review (galois/godel are near the seed write-path).

## Spec home

In-place editing bypasses the lens entirely (single-click still anchors the lens). It is a
new direct-manipulation `edit-surface`, fitting the existing affordance taxonomy. Documented
here; `rwa-lens-spec.md` gets a short boundary note so the gesture split is recorded beside
the lens anchor and can't drift.
