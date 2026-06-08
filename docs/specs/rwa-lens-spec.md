# rewritable: edit model

*A specification for the editing surface*

---

## 1. The Problem

The core spec defines a self-modification loop and rwa-edit/1 defines how its bytes flow: ⌘K opens a prompt, the agent edits the document via `apply_edits`, `apply_dsl_plan`, or `replace_document`, the runtime audits and applies the result. The byte-level mechanics are solid — `apply_edits` is byte-stable for everything outside the (find, replace) windows, frozen zones are mechanically protected, validation rejects malformed envelopes.

What is not solid is the user-surface layer. ⌘K is a single modal prompt regardless of how the bytes flow underneath. The document feels finished; the prompt feels like a separate program you invoke against it. That is app-shaped, not document-shaped, and it makes the empty-state question awkward — what *is* a blank rewritable, before you have ever pressed ⌘K?

This spec defines an editing model that is document-shaped: a single steerable input — the *lens* — whose position determines what your input does. The lens has two states, the slash key discriminates content from instruction, and every gesture compiles down to an existing rwa-edit/1 envelope. No new edit protocol; just a clearer surface to drive the existing one.

The lens model also opens a use case the core spec underweights: *formal documents*. Contract templates with locked legal language and editable variables. Tax-form rewritables with locked structure. Press releases with locked attribution and disclaimer. Publication-ready columns where the byline cannot be rewritten by an *improve the prose* prompt. Lockable regions are a different value proposition than the self-modifying-tracker pitch — *this part is fixed, everything else is malleable* — and the lens model is the right surface for both regular prose drafts and formal documents whose structure must not drift.

**Scope.** This spec defines an editing model for *prose-shaped* rewritable documents — content rendered directly from `rwa_doc` source. Documents with significant data-rendered regions (trackers, kanbans, spreadsheets) are addressed in a separate spec. Where this spec refers to "the document," it means a structure of prose blocks in source form.

---

## 2. The Lens

The lens is a single text input that moves through the document. It has two states.

| Lens state | Direct text | Slash command |
|---|---|---|
| **Default (global)** | Appends at EOF | Applies to whole document |
| **Anchored on block** | Inserts after block | Edits the block |

The lens is always somewhere. In the default state, it is docked at the bottom of the viewport like a chat input — your text either lands at the end of the document (direct text) or transforms the whole document (slash command). In the anchored state, it sits inline below a specific block, with a small badge indicating its anchor. Anchored direct text inserts after the block; anchored slash commands edit the block.

Two states, four behaviors, one badge to indicate which state you are in.

The model maps to a pattern citizen-developers already know: Slack's *send to channel* (default) versus *reply in thread* (anchored). The chip-with-X for applied scope is one of the most universal UI patterns on the web. The lens is the rewritable equivalent.

---

## 3. Relationship to rwa-edit/1

Every gesture the lens supports compiles down to an existing rwa-edit/1 envelope. This spec does not define a new edit protocol; it defines a user-surface layer over the existing one.

| Lens gesture | Compiles to |
|---|---|
| Default + direct text | `apply_edits` envelope, single edit, find = EOF anchor, replace = anchor + new content |
| Default + slash command | Multi-turn rwa-edit/1 loop with full document context; agent picks tool |
| Anchored + direct text | `apply_edits` envelope, single edit, find = anchored block source range, replace = source + new content |
| Anchored + slash command | `apply_edits` envelope (or `apply_dsl_plan`), find = anchored block source range, replace = agent response |

Every envelope flows through the existing audit log and validation machinery. Frozen zones are protected by the existing post-apply byte-identical check (rwa-edit-spec.md §6 rule 3) plus a lens-runtime extension for class-declared locks (§7). The modify mutex (rwa-edit-spec.md §5.5) serializes one envelope at a time across all four behaviors.

The spec below describes user behavior; the protocol below it does not change.

---

## 4. Default State

The default state of the lens is a chat-input-style bar docked at the bottom of the viewport. Whatever the user types is provisional — prose by default, command if it begins with a slash.

### 4.1 The blank state

An empty rewritable opens with the lens already in default state, occupying whatever vertical space the empty viewport gives it. There is no separate build screen, no description form, no agent call on first open. The document is empty because it is empty; the lens is there because it is always there. You start writing or you start prompting and the document accumulates.

The first append from a genuinely-empty document compiles to `replace_document`, not `apply_edits` — an `apply_edits` envelope with `find: ""` is illegal per rwa-edit-spec.md §4 rule 3. The predicate for *genuinely-empty*: `rwa_doc` parses to no anchorable elements per §5.5. This covers both `rwa_doc === ''` and seeds shipping a structural skeleton (e.g., `<article></article>` with no content blocks). The runtime supplies `reason: "initial content into an empty document"` for the envelope; `replace_document` validation requires the field. After the first content lands, all subsequent appends use `apply_edits` with an EOF anchor.

### 4.2 Direct text appends at EOF

In default state, direct text — submitted with ⌘Enter — adds a new block at the end of the document. The lens compiles a single-edit `apply_edits` envelope, the runtime applies it, and the new block appears at the end. The lens stays docked. Direct text wraps in `<p>` per the rule in §5.3.

**EOF anchor resolution.** The EOF anchor resolves to the source range of the last anchorable block in `rwa_doc`, identified via the source-position map (§5.5). Locked blocks (§7) are excluded from the resolution, so the EOF skips a locked footer and lands above it. The synthesized edit takes the last anchorable block's source as `find` and that source followed by the new wrapped content as `replace`. Any content after the last anchorable block (trailing whitespace, comments, a locked footer if present) is preserved on the far side of the new content, because `find` does not include it.

If the user has scrolled away from the end, a small hint above the lens — *will append at end* with a down-arrow icon — orients them. Clicking the hint scrolls to the EOF.

### 4.3 Slash commands target the whole document

In default state, a slash command — `/convert this to a kanban board`, `/dark mode`, `/tighten throughout` — runs the existing rwa-edit/1 multi-turn loop with the full document as context. The agent picks the tool. Sometimes that is `replace_document` (for fundamental restructuring), sometimes `apply_dsl_plan` (for systematic field-level changes), sometimes `apply_edits` (for surgical multi-region tweaks). The lens does not constrain the agent's choice; it just initiates the loop.

This is the path that makes whole-document transformations available.

---

## 5. Anchored State

When the lens is anchored on a block, it sits inline below that block. A small badge at the top-left of the lens shows the anchor with an X to release. The document below the anchored block pushes down to make room for the lens.

### 5.1 Anchoring

Anchoring is primarily a click — click a block, the lens moves to sit below it. Drag-and-drop on the lens itself is supported as the explicit alternative gesture. Both produce the same end state.

The runtime visually highlights the anchored block (subtle border or background tint) so the user always knows what the lens is targeting. The badge on the lens shows the anchor's identity (e.g., *anchored on ¶3*) and, when the anchor has scrolled out of view, augments with a position cue (*anchored on ¶3 — scrolled above*) plus a click-to-return affordance. Without those indicators, the lens model has a known failure mode: sticky scope. Unlike a momentary selection, the anchor persists across multiple submissions until released, which is more powerful for multi-step edits on the same region but easier to forget.

**Single-click vs double-click.** A **single** click anchors the lens (above). A **double** click on a leaf text block enters *inline manual edit* — a distinct direct-manipulation `edit-surface` that bypasses the lens entirely: the block becomes `contenteditable`, the user edits the text by hand, and Enter/blur commits through the non-agent path (`actor:'user:edit-surface'`) with **no model call**. This is not a lens mode and uses none of the lens chrome; it is documented in `docs/plans/2026-06-08-inline-manual-edit-design.md`. The two gestures coexist on the same blocks via click-count; double-click leaving the live word selected is standard word-processor behaviour, and an edit that blurs with no change commits nothing, so accidental entry is free.

### 5.2 Releasing the anchor

The X on the badge releases the anchor and returns the lens to its docked default position. **Esc** is the keyboard equivalent. The document layout reflows back; transitions animate briefly to avoid jarring jumps.

A "down" button on the lens scrolls to the EOF and re-anchors as default — the navigation gesture for *I'm done editing this region, I want to go back to writing-at-end.*

### 5.3 Direct text inserts after the anchored block

Anchored direct text adds a new block immediately after the anchored block, between it and whatever followed. This compiles to an `apply_edits` envelope where `find` is the anchored block's source range (per §5.5) and `replace` is that same source followed by the new content. The runtime applies, the new block appears, the lens stays anchored on the original block.

This is the spec's most subtle behavior: anchoring on paragraph 3 and typing prose creates a new paragraph after 3, not a modification of 3. The semantic — *use this block as my insertion point* — serves a real prose-author motion (drafting transitions, adding context to an existing argument, weaving in an example) but is not derivable from the word "anchor" alone. Discoverability is on the affordance, which the runtime renders explicitly:

- The lens placeholder text shifts when anchored: *insert after this block, or `/edit` it*.
- A thin insertion line renders above the lens, visualizing exactly where new content will land.
- A small directional icon (↵) on the input itself reinforces the after-this-block direction.

Without those affordances, anchored direct text is the cell of the matrix users will get wrong most often. With them, it becomes a discoverable shortcut.

**Block wrapping.** Direct text submitted as prose must be wrapped in HTML blocks before it lands in the envelope. The wrapper is determined by the insertion context, keyed on the anchor type:

| Anchor type | Wrapper | Insertion lands in |
|---|---|---|
| `<li>` | `<li>` | parent `<ul>` or `<ol>` |
| `<blockquote>` | `<p>` | document/body level (after `</blockquote>`) |
| `<pre>` | `<p>` | document/body level |
| All others (incl. `<p>`, `<h1>`–`<h6>`, `<figure>`, `<aside>`) | `<p>` | document/body level |

In default state (no anchor), the wrapper is `<p>` — insertion is at document/body level. Multi-paragraph direct text splits on blank lines and wraps each chunk in the resolved wrapper. The `<li>` special case prevents the silent invalidity of `<p>` elements appearing as direct children of `<ul>` or `<ol>`. In `<li>` context, multi-paragraph direct text produces multiple list items, one per chunk — this matches the natural reading of *anchored on a list item, adding more list items* and is acceptable for v1. Documents that need a different wrapping rule can override the runtime's behavior by exposing a hook; the default covers the prose case.

### 5.4 Slash commands edit the anchored block

Anchored slash commands target the block itself. The agent receives the anchored block as the *target*, a bounded window of surrounding context (containing section, document title, surrounding headings — see §10), the user's instruction, and a directive to *modify the target*.

The runtime compiles the agent's response into an `apply_edits` envelope where `find` is the anchored block's source range (§5.5) and `replace` is the response. Everything outside the block is byte-identical pre- and post-edit by construction, validated by the existing rwa-edit/1 machinery. The response itself is also validated against the target's parent context before envelope construction (§10) to ensure it does not produce structurally invalid HTML.

The anchor defines what is *replaced*, not the *length* of the replacement. The agent may return any size of response.

**Post-commit anchor behavior.** After the envelope commits, the lens may stay anchored or release depending on the response shape. *Single block* here means exactly one anchorable element per §5.5 after parse:

- **Single anchorable block.** The lens re-anchors on the new block — the source-position map rebuilds during the post-commit pass, identifies the new element's range, and the anchor follows. This supports sequential editing of the same content (`/tighten this`, then `/add a transition`, then `/strengthen the conclusion`) without re-clicking.
- **Multiple anchorable blocks.** The lens releases to default with a brief affordance — *anchor released — response was multi-block* — because v1 does not support multi-anchor (§11.4).
- **Empty response.** The lens releases without affordance, since the anchored content no longer exists. This is the path for `/delete this` and similar instructions where the user intent is removal.

Default-mode commands do not have an anchor to update either way.

### 5.5 Anchor resolution

The user clicks somewhere in the rendered DOM. The runtime resolves that click into a unique `find` string the rwa-edit/1 envelope can act on. Four pieces.

**What counts as an anchorable block.** The anchorable set for prose: `<p>`, `<h1>`–`<h6>`, `<blockquote>`, `<li>`, `<figure>`, `<pre>`, `<aside>`. Excluded: `<hr>` (no editable content — to insert content adjacent to an `<hr>`, anchor on the preceding or following block), `<ul>` and `<ol>` (anchor on the contained `<li>` instead — finer-grained matches the user's mental model for editing list items). Definition lists (`<dl>`, `<dt>`, `<dd>`) are not in v1's anchorable set; clicks on definition-list content traverse upward to the next anchorable ancestor or no-op if none exists.

**Click resolution.** From the click target, traverse up the DOM until reaching an ancestor in the anchorable set. A click on inline content like `<strong>` inside a paragraph anchors the containing `<p>`. A click on text inside a list item anchors the `<li>`. If no anchorable ancestor exists — for example, a click landing in the margin between two blocks resolves only to the document body or article root, neither anchorable — the click is a no-op and the lens stays in its prior state. Clicks on the lens itself are focus events, not anchor events; the lens is a separate UI element outside the document body.

**Source mapping.** The `find` field of the synthesized envelope must be a substring of `rwa_doc` source. `block.outerHTML` is *not* that substring — browser serialization normalizes attribute quoting, attribute order, self-closing tag form, boolean attributes, and whitespace inside opening tags, none of which are guaranteed to match the source. The runtime instead maintains a *source-position map*: at parse/render time, it records a `[startOffset, endOffset]` range in `rwa_doc` for each anchorable element. Click resolution gives a DOM element; the recorded range gives the exact source substring for `find`.

The implementation of the source-position map is left to the runtime — viable approaches include an offset-tracking parser, a lockstep walk between source and DOM during render, or a deferred substring-search with normalization fallback. The spec commits only to the invariant: *the recorded range, when extracted from `rwa_doc`, equals the block's source-form content.* The map is in-memory and ephemeral — built at parse/render time, rebuilt after each successful envelope commit, never persisted. This is the runtime equivalent of the "copy from input verbatim, not retype" discipline rwa-edit-spec.md §4 rule 1 imposes on the agent.

**Source uniqueness.** If the recorded range's content is unique within `rwa_doc`, that is the anchor. If not — two empty `<p></p>` placeholders, two `<blockquote>` quotes with the same short text, repeated `<li>Yes</li>` items in different lists, two `## Examples` headings — the runtime extends `find` with surrounding context: include the preceding sibling's source range (and adjust `replace` to include the same prefix), then the following sibling, expanding outward until `find` is unique. This is the same disambiguation discipline rwa-edit-spec.md asks of the agent for `apply_edits` anchors; the runtime applies it deterministically when synthesizing.

If a block cannot be made unique even with full document context (a pathological case, rare in prose), the runtime refuses the anchor with a brief affordance — *this region is ambiguous; edit the source directly* — and the lens stays in its prior state.

---

## 6. The Slash Convention

The first character of an input determines how a submission is interpreted.

- **No leading slash** — direct text. Inserted at the lens position (default = EOF, anchored = after block).
- **Leading slash** — command. Sent to the agent as an instruction; agent's response replaces or transforms content per the lens state.
- **Escape**: `\/` at the start of a submission produces a literal slash in the content. Required when prose genuinely starts with a slash (URL fragments, code paths, fiction conventions like `/me waves`, IPA-style phonetic notation `/foʊ.nɛ.tɪk/`).

The submit gesture is **⌘Enter** in either mode. Plain **Enter** is always a newline; users drafting multi-line prose need newlines without accidentally submitting.

The slash discriminates the *meaning* of the submission; ⌘Enter triggers it. The two are orthogonal — slash without ⌘Enter is just text in the input that the user has not yet committed.

### 6.1 Live mode indication

The discriminator is invisible at the moment it matters most — during typing — unless the runtime makes it visible. As soon as the input contains a leading `/`, the lens chrome shifts:

- The border accent changes to a "command" treatment (distinct color or weight).
- The placeholder text shifts to *running an agent command*.
- A small "command" pill appears on the input.

The user sees the discriminator engage before they commit. Discord and Linear both do this, for the same reason: silent failure modes are worse than visible state changes.

### 6.2 Paste-detection hint

Pasted content is the most common way prose accidentally starts with a slash — a URL fragment, a code snippet, a path. When the user pastes content that triggers the slash discriminator, the lens surfaces a one-time hint: *Looks like content — escape the leading slash with `\/` to insert literally.* The detection heuristic for v1 is *multi-line content containing additional slashes*; richer signals (URL patterns, indentation suggesting code, `://` substrings) can be added incrementally. The hint is heuristic, not enforcement — it converts the silent footgun into a visible suggestion.

§6.1 and §6.2 layer. The live mode indicator (§6.1) is the primary defense — every leading-slash input triggers the chrome shift, including single-line slash-leading pastes like a `/api/v1/users` URL. The paste-detection hint (§6.2) is a secondary catch specifically for multi-line code-shaped pastes where the user's attention may not be on the lens chrome at the moment of paste.

---

## 7. Frozen Regions

The core spec and rwa-edit-spec.md already define a complete frozen-region mechanism: comment-fence markers (`<!-- rwa:frozen:begin <name> -->`), the `data-rwa-frozen` attribute, byte-identical preservation through `replace_document`, and the deliberate friction of requiring external file editing to add or remove zones (rwa-edit-spec.md §7).

The lens model adds a UI affordance, not a new mechanism. A block declared with `class="rwa-locked"` is treated by the runtime as a frozen zone. The runtime renders the locked state visually (subtle stripe, lock icon in corner), and:

- **Anchoring is rejected.** Click or drag on a locked block produces a brief affordance (*this region is locked*) and the lens does not anchor.
- **Slash commands cannot reach the locked content.** Lock enforcement combines rwa-edit-spec.md §7's mechanism with a lens-runtime extension. For zones declared via the marker forms (comment fences or `data-rwa-frozen`), rwa-edit/1's validator already enforces preservation: `replace_document` is byte-validated against the frozen-zone set, `apply_edits` cannot include marker substrings, and any envelope that would touch the locked content is rejected before commit.

For zones declared via `class="rwa-locked"`, the runtime extends validation. The check semantics depend on the envelope kind:

- For `apply_edits` and `apply_dsl_plan`: the runtime identifies the source ranges of `.rwa-locked` blocks (via the source-position map of §5.5) and rejects any envelope whose individual edits' find ranges overlap a locked range. Adjacent insertions (where a find range ends exactly where a locked range begins) are not overlap and are accepted.
- For `replace_document`: the envelope is rejected if `rwa_doc` contains any `class="rwa-locked"` block whose source range is not entirely contained within a marker-form frozen zone (comment fence or `data-rwa-frozen`, per rwa-edit-spec.md §7). *Coverage direction matters*: the `.rwa-locked` range must be a subset of (or equal to) the marker zone's range — markers wrap or equal the lock, not the other way around. The inverse pattern (marker fences nested inside a `.rwa-locked` wrapper) does not satisfy coverage, because markers preserve only their inner content; a `replace_document` could legitimately strip the lock wrapper and leave the marker-protected content intact-but-no-longer-locked. The conservative rejection matches what the marker actually guarantees.

The bare class alone has no protocol-level preservation through wholesale rewrite — matching blocks across rewrites is fragile (position changes, content paraphrase). Authors who want both the UI affordance and `replace_document` survival declare both forms on the same block: place comment-fence markers outside the `.rwa-locked` block, or apply `data-rwa-frozen` directly to the lock element. In either case the marker form provides the byte-identical preservation rwa-edit-spec.md §6 rule 3 already enforces, and the runtime's coverage check sees the marker protection and allows the envelope. The rwa-edit/1 retry loop's failure context names the constraint when rejection fires, so the agent can re-attempt with `apply_edits` or `apply_dsl_plan` for documents where coexistence is not in place.

The agent's prompt names `.rwa-locked` blocks alongside marker-declared frozen zones in rwa-edit-spec.md §9.1's `<FROZEN_ZONES>` block, so the agent does not routinely propose envelopes that touch them. The prompt also notes that `replace_document` is unavailable on documents containing class-declared locks not covered by marker forms — for such documents the agent should pick `apply_edits` or `apply_dsl_plan`. Without these notes, the retry loop would consume budget rejecting drift the agent had no way to anticipate.

Locks are added by external file editing — the friction of *open the .html in your editor* is the feature, not the bug. This makes locks meaningful for the formal-document use cases (contracts, tax forms, attribution): a recipient cannot unlock the legal language by clicking a button. To revise a locked region, the author edits the file directly.

A document whose final block is locked has no append zone in the conventional position. The shifted insertion point is a natural consequence of the EOF resolution defined in §4.2 — *last anchorable block* skips locked blocks, so the runtime resolves EOF to the position above the locked footer automatically. The hint text changes from *will append at end* to *will append above locked footer* so the user understands where new content lands.

A locked tail is effectively the terminal block of the document — there is no path to insert content below it from inside the running document. To add content after a locked footer, the author edits the file externally. This matches the design intent: a locked footer is something the author has declared immutable from inside the document; the only way to change what comes after it is to change the document itself, in an editor.

Lock toggling from inside the running document is deliberately unsupported in v1. Allowing the agent or the in-document UI to add or remove locks introduces a recursive concern (an agent locking its own modifications against future edits, or a user accidentally unlocking attribution) that needs more thought.

---

## 8. History

The existing `rwa_hist` schema (rwa-edit-spec.md §5.1, §6) records `{ ts, kind: 'edit_batch', envelope }` and `{ ts, kind: 'replace_document', reason }`, capped at 15 entries, atomically committed in the same IDB transaction as `rwa_doc` and `rwa_undo`. The lens model extends this schema; it does not replace it.

### 8.1 Schema extension

Each existing record gains three fields:

```javascript
{
  ts,
  kind: 'edit_batch' | 'replace_document',
  envelope,                    // existing — the precise rwa-edit/1 payload
  reason,                      // existing — for replace_document
  surface: 'default-text' | 'default-command'
         | 'anchored-text' | 'anchored-command',
  instruction: string,         // user's submitted text (for command surfaces); '' for text surfaces
  scope: {                     // what the lens was targeting
    type: 'eof' | 'block' | 'document',
    block_id?: string,         // for anchored surfaces
  },
}
```

The envelope remains the audit-trail truth — *exactly which (find, replace) pairs got applied* is what debugging drift requires. `surface`, `instruction`, and `scope` are added context, not replacements.

### 8.2 Capacity

The 15-entry cap raises to **1000**. Finite for storage hygiene, large enough to cover months of weekly drafting on a single column. `rwa_undo` keeps its tighter 10-entry cap; the two stores serve different purposes and can have different retention.

A note on storage envelope. A complex `apply_edits` envelope can be tens of KB; 1000 of them is a meaningful slice of IndexedDB quota for a long-lived container. v1 ships the cap as-is, but the dimension is worth tracking. A v2 refinement may apply a per-record size cap (truncate `replace` fields beyond a threshold in older entries) before raising the count cap further.

### 8.3 Surfacing

A history pane (collapsible, off by default) renders `rwa_hist` chronologically: instruction text, surface, timestamp, with a hover affordance pointing to the affected region. The pane is read-only. Restoring a prior state is the undo stack's job — undo recovers content, history recovers *intent*.

### 8.4 Privacy

`rwa_hist` lives in IndexedDB; only `rwa_doc` is serialized into the inline snapshot at commit time (core spec §5.6 + Invariant 7). A document shared with a recipient does not carry the sender's history. Documents that need shared history (collaborative drafting tools) opt in by writing history into a document-defined store rather than `rwa_hist`.

---

## 9. Concurrency and In-flight State

The modify mutex from rwa-edit-spec.md §5.5 carries over unchanged: one envelope at a time, regardless of which lens surface initiated it. The lens UI reflects this.

Direct text appears in the document immediately on submit; there is no agent call, so streaming does not apply. The synthesized envelope commits atomically.

Slash commands stream content as it arrives — into the new-content area for default-state commands, into the anchor block for anchored-state commands. During flight, the input is disabled and shows a thinking affordance. The target shows a streaming indicator. After completion the runtime commits the envelope and the audit log records.

If a command is cancelled mid-flight, the in-progress streaming UI is discarded; `rwa_doc` was never mutated, so no rollback is needed. The audit log optionally records an `aborted` entry — useful for debugging but not load-bearing for state recovery. This wording assumes §11.2's conservative streaming direction (commit only on completion); if the protocol-extension path is later adopted, cancel semantics would need revision because `rwa_doc` would be partially mutated mid-stream.

If the stream completes but the resulting envelope fails validation — forbidden marker substring; frozen-zone violation including the class-declared extension of §7 (overlap for `apply_edits`/`apply_dsl_plan`, rejection for `replace_document` on docs containing class-declared locks not covered by marker forms); parent-context violation per §10's response validation; structural shape changed by an inadvertent edit — the streaming UI clears, the target reverts to its pre-stream content, and the rwa-edit-spec.md §9.2 retry loop proceeds normally; subsequent streaming attempts replace the cleared UI. After retry exhaustion the user sees the standard rwa-edit/1 failure surface. The lens does not invent a new failure UX; it inherits the one already defined.

Streaming is a small protocol extension to rwa-edit/1: the runtime accepts an in-progress edit affordance that does not pollute the audit log unless completed. See §11.2.

---

## 10. Agent Contract per Surface

The agent receives a different prompt depending on which surface invoked it. Direct-text surfaces do not invoke the agent at all — they synthesize envelopes from user input directly.

**Default + slash command.** The agent receives the full document and the existing rwa-edit/1 system prompt unchanged, augmented to name `.rwa-locked` blocks alongside marker-declared frozen zones in the `<FROZEN_ZONES>` block (per §7) and to note that `replace_document` is unavailable when class-declared locks are present without marker-form coexistence. It picks the tool. This is the path for whole-document transformations.

**Anchored + slash command.** The agent receives:

- The anchored block as the *target*
- A bounded context window: containing section, document title, surrounding headings
- The user's instruction (with the leading slash stripped)
- A scope directive: *return a replacement for the target block, of any length. Output naked HTML markup only — no markdown fences, no commentary, no preamble or explanation. The first character of the response must be the first character of the replacement block. If the target is contained in a parent that requires a specific child type (e.g., `<li>` inside `<ul>` or `<ol>`), every top-level element of the response must use the same type as the target — return `<li>` element(s) when anchored on `<li>`, never `<p>` or other types.*

The naked-HTML discipline mirrors rwa-edit-spec.md §9.1. Without it, models reliably wrap the response in code fences or prose preamble, and the runtime then has to strip them — a fragile path. The parent-type constraint is similarly load-bearing: without it, an agent asked to *make this more formal* on an `<li>` reasonably returns `<p>...</p>`, which would land inside `<ul>` and produce structurally invalid HTML.

**Response validation.** Before constructing the envelope, the runtime validates the agent's response against the target's parent context. The check operates on every top-level element of the response, not just the first — a multi-element response might begin with a valid `<li>` and follow it with an invalid `<p>`, and both must be caught. v1 enforces a single rule: if the target's parent is `<ul>` or `<ol>`, every top-level element of the response must be `<li>`; the response is rejected if any top-level element is not. (Other parents in the v1 anchorable set accept flow content, which all anchorable types are, so no other parent-type constraint applies.)

A rejected response surfaces as a structured failure in the rwa-edit/1 retry loop (rwa-edit-spec.md §9.2). The retry typically succeeds because the failure context names the constraint the agent missed. This guard, together with the prompt-level constraint, is what makes invariant 12 hold for the slash-command path — prompt drift on structural rules is real, and the runtime check is the second line of defense.

The runtime compiles the response into an `apply_edits` envelope. The agent does not see the full document or any blocks outside the context window — bounded blast radius, focused prompt, smaller token cost.

**Context window definition.** *Containing section* is implementation-defined for v1. The constraint is that the window must be bounded and labeled distinct from the target. Candidate heuristics: *heading-relative* (blocks between the nearest preceding heading at the same or higher level and the next such heading), *fixed-block window* (N blocks before, N blocks after, e.g., N=3), or *token budget* (expand outward until a budget is reached). Each has different cost and shape characteristics; v1 implementations pick one and document the choice. v2 may pin a default once usage data accumulates. The important constraint: implementations must not silently default to *send the whole document*, which would erase the bounded-blast-radius property the anchored surface advertises.

For all four surfaces, the audit log records what was sent, what came back, and what was applied.

---

## 11. Open Questions

### 11.1 Plain Enter and short prompts

⌘Enter is the submit gesture; plain Enter is a newline. But a user typing a one-line slash command will instinctively press Enter to send. Mitigations: distinct visual treatment of the lens vs. document body, a submit hint beside the input ("⌘Enter to send"). *Smart submission* — Enter submits if the input is one short line and starts with `/` — is rejected because the failure mode (the user wanted a newline, the agent ran) is surprising.

### 11.2 Streaming and the audit log

Streaming responses are useful for felt-sense but do not fit the rwa-edit/1 envelope model cleanly — an envelope is a complete edit, but a stream produces partial content. Two directions: render streaming purely as a UI affordance and only commit the envelope when the stream completes (the conservative path), or extend rwa-edit/1 with a streamed-edit kind that commits incrementally (more invasive). Current direction: conservative, defer the protocol extension. §9 cancel and validation-failure semantics assume this direction.

### 11.3 Sub-block anchoring

Anchoring is block-level. Sentence-level or word-level anchors would require a richer selection model and more careful handling in the rwa-edit/1 compile-down. For v1, sub-block edits go through the block — `/tighten the second sentence` while anchored on paragraph 3.

### 11.4 Multi-anchor

Some edits naturally span multiple non-contiguous blocks (*merge these two paragraphs*, *make all the headings in this section title-case*). The lens model handles only one anchor at a time. Multi-anchor mode — shift-click adds, click releases — is a possible extension, deferred. The §5.4 post-commit rule (multi-block response releases the anchor) is a temporary measure that multi-anchor would replace.

### 11.5 Drag-and-drop interaction details

Drag is supported as the explicit alternative to click-to-anchor, but the precise affordance — does the entire lens lift on grab, does a ghost icon follow the cursor, what is the drop preview — is unspecified. v1 uses a conservative implementation; refinement waits for usage.

### 11.6 Bare class-declared locks through replace_document

v1 supports `replace_document` survival for class-declared locks only when they coexist with marker-form declarations on the same block, with the marker zone wrapping or equal to the lock range (§7). For locks declared *only* via `class="rwa-locked"` with no marker accompaniment, `replace_document` is rejected. A v2 extension could allow bare class-declared locks to survive `replace_document` via a stable identifier (e.g., `<section class="rwa-locked" data-lock-id="legal">`) with content matched by id rather than position. Defer until a use case demonstrates the v1 coexistence pattern is too burdensome.

---

## 12. Invariants

These properties are load-bearing — every change to the lens model should preserve them.

1. Every lens gesture compiles to a valid rwa-edit/1 envelope. The lens does not bypass the protocol.
2. The agent never modifies a frozen zone. Mechanically — by anchor rejection, post-apply byte-identical validation for marker-declared zones, and the lens-runtime overlap check (`apply_edits`, `apply_dsl_plan`) plus rejection of `replace_document` on documents containing `class="rwa-locked"` blocks not entirely contained within marker-form frozen zones (§7) — not contractually.
3. Direct text in any state produces additions, not replacements. The existing document body is byte-identical pre- and post-text-submission.
4. Slash commands in anchored state modify only the anchored block. The document outside the anchor is byte-identical pre- and post-edit.
5. Slash commands in default state can touch any part of the document except frozen zones; the standard rwa-edit/1 validation plus the §7 lens-runtime extension enforce this.
6. Every command invocation lands in `rwa_hist` with its full envelope plus the lens-specific surface, instruction, and scope fields.
7. `rwa_undo` and `rwa_hist` are not serialized into the inline snapshot. A shared file is a clean state, not a state plus its history.
8. Plain Enter in the lens is always a newline. ⌘Enter is always submit.
9. Locks toggle only via external file editing, not from inside the running document.
10. The lens has exactly two states (default, anchored). There is no third state and no hidden state.
11. The runtime's source-position map satisfies: for every recorded `[startOffset, endOffset]` range, the substring of `rwa_doc` at that range equals the corresponding block's source-form content. The map is the bridge between DOM clicks and rwa-edit/1 envelopes.
12. Direct text submitted as prose wraps in HTML blocks per the §5.3 wrapping table before reaching the envelope. Slash-command responses are validated against the target's parent context before envelope construction (§10) — every top-level element of the response must satisfy the parent-type constraint, not just the first. The synthesized envelope produces structurally valid HTML for the supported anchorable set defined in §5.5, on both the direct-text and slash-command paths.

---

*Spec version 0.9 — final draft, shipping wording. Companion to re-write-able core spec v0.10 and rwa-edit-spec.md v1.4.*
