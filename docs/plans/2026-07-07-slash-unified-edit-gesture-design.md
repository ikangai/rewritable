# Slash — the unified in-document edit gesture

**Status:** BUILT (2026-07-07, agent-13). Worktree `feature/slash-edit`, held for operator merge.
**Trigger:** operator goal — port the reference `Slash Prompt-3.html` ("E · Slash") editing
model onto `seeds/rewritable.html`.

**Built:** all of §3–§6. Seed changes (all additive to the inline-edit/mode/selection layer):
`commandStartIndex` + `commitInlineEdit` gain the `//` escape (symmetric to `\/`);
`selectionLeafEntries` / `buildSlashInstruction` / `runSlashScope` added beside
`refreshInlineEditAffordances`; `#rwa-pal` gains a `palScope` + scope chip and routes Enter via
`runSlashScope`; a document-level `/` keydown beside the ⌘K handler. Pinned by `tests/inline-edit.mjs`
groups **C6/C6b** (`//` escape) and **G1–G10** (selection resolution, `buildSlashInstruction`,
end-to-end single-block agent scoping, and the doc-level `/` router). Verified: inline-edit
**184/0**; neighbors green (mode 18, view 23, lens 262, image-assets 92, e2e 294, ai-chip 76,
intelligence-drop 38, artifact-bus 66, skin-compose 89, chip-edit 26, backends 16, write-path 10);
conformance **86/86**; references regenerated (carriers re-verified). Real-browser pass of the
native-selection + live-chip behavior is the one step jsdom can't cover — see §9.

> The document is the editor. Click anywhere and type — direct edits, no model. Type `/`
> mid-text for a block instruction. Select text first and `/` targets exactly that
> selection — across blocks too. Press `/` with nothing focused and it addresses the whole
> document. Mid-word slashes (and/or, 6/7) type normally, `//` gives a literal `/`.

The reference is a clean-room demo (framework: `x-dc`/`DCLogic`, a mock rewriter). The
*interaction* is portable; the mock is not. We map the interaction onto the seed's real
substrate: agent `modify()`, the anchor-based rwa-edit/1 contract, frozen zones,
`data-rwa-id`, the undo stack, and the runtime mode manager.

## 1. Requirements → current seed state → delta

| # | Requirement | Seed today (per `tests/inline-edit.mjs`) | Delta |
|---|---|---|---|
| R1 | Click anywhere, type = direct edit, no model | Single/double-click a leaf → contenteditable; Enter/blur commit via `commitInlineEdit` → `runtimeApplyEnvelope` (`actor:user:edit-surface`); Esc reverts; empty deletes (E0–E15). **Gated on Edit mode.** | Confirm click-to-type is seamless in Edit mode. Decide the mode model (§4). |
| R2 | `/` mid-text → block instruction | `commandStartIndex()` detects a word-boundary `/` (leading or mid-block); `data-rwa-cmd='on'`; Enter → `runAnchoredCommand` (`surface:anchored-command`) on the block; the `/…` text is never committed (C1, C1d, C3). | Keep. Only the escape convention changes (R6). |
| R3 | Select + `/` → instruction scoped to **exactly that selection, across blocks** | **Missing.** A selection shows the deterministic formatting bar (`runSelectionCommand`: bold/italic/headings/…); there is no selection-scoped *model* prompt. | **New.** Single-block and multi-block selection → a model instruction scoped to the selection (§3). |
| R4 | `/` with nothing focused → whole document | **Not wired to `/`.** ⌘K opens the whole-doc lens (`rwa-lens`/`rwa-pal`). | **New.** A document-level keydown: `/` with no editable focus → open the whole-doc prompt (reuse the lens). |
| R5 | Mid-word `/` stays literal (`and/or`, `6/7`, URLs) | Present — `commandStartIndex` requires a word boundary; C1d pins `http://example.com/path` as non-command. | Keep (extend the same rule to the new selection/doc paths). |
| R6 | `//` → literal `/` | Seed uses `\/` (backslash) as the literal-slash escape (C1, C1b). | **Change** the convention to `//` (keep `\/` working too — additive, so no muscle-memory regression). |

## 2. The one principle that keeps this safe

The reference mutates a JS state object. The seed **never** does DOM-as-source-of-truth: every
change is an rwa-edit/1 envelope spliced by the applier, guarded by frozen zones, reserved-marker
checks, structural-shape preservation, and `data-rwa-id` stability. **This port adds gestures
that *produce* envelopes; it does not add a new write path.** Direct text → the existing
`user:edit-surface` commit. `/`-instructions → the existing `runAnchoredCommand` / `modify()`.
Selection-scoped `/` reuses those two, only narrowing the instruction (§3). No new commit
primitive, no new undo semantics, no frozen-zone bypass.

## 3. R3 — the selection-scoped model instruction (the hard part)

The reference string-splices `mockRewrite(selectedText, instr)` back into the block. The seed
has a real agent and an anchor contract, so "scope to the selection" becomes "constrain the
instruction so the agent only changes the selected span," then let the normal applier splice.

**Scope inference (mirrors the reference `handleKey` / `selectionBlockIds`):**

- **Selection within ONE block + `/`** → inline prompt (a `/` chip after the highlighted span,
  matching the reference's `startSelChip`). Run **`runAnchoredCommand` on that block**, with the
  instruction augmented:
  > *Within this block, change only the following selected text and leave everything else byte-identical: «SELECTED». Change to make: «INSTRUCTION».*
  The agent returns the whole block (its `data-rwa-id` preserved) with just that span rewritten;
  the existing block-scoped applier commits it (`surface:'anchored-command'`, one undo frame). No
  new primitive.

- **Selection across MULTIPLE blocks + `/`** → the docked bar (reference `openBar('sel', ids)`),
  scope chip "Selection · N blocks". Run **`modify()`** (the ⌘K whole-doc path) with the
  instruction augmented to name the spanned blocks + quote the selection:
  > *Apply this change ONLY to the selected text, which spans these blocks [ids]: «SELECTED». Leave all other content byte-identical. Change: «INSTRUCTION».*
  `modify()`'s apply_edits anchors on the selected text; one commit, one undo. This reuses the
  doc-level path rather than inventing a multi-block-anchored primitive — honest and minimal.

- **Selection at document level** (nothing focused, text selected) + `/` → same docked bar,
  scope = selection (single- or multi-block resolved by `selectionBlockIds()`).

**Why not a per-block loop (as the reference does)?** The reference's per-block loop is an
artifact of its mock (no cross-block anchoring). The seed's `modify()` already edits an arbitrary
span across the doc in one envelope/commit — using it is *fewer* moving parts and gives one ⌘Z,
matching the reference's single "Undo this edit."

**Selection-block resolution** = port `selectionBlockIds()`: walk `[data-rwa-id]` leaves,
collect those the Range `intersectsNode`s. Frozen/`.rwa-locked` blocks in the span are excluded
from the instruction's target set (the frozen wall holds — a selection that touches a frozen
block simply won't instruct changes to it; if the whole selection is frozen, decline with a note).

## 4. Mode model — decision

The reference has no modes (always editable). The seed's Document/Edit/View mode system is
load-bearing (reading view, presentation `active-view` inertness — `tests/view.mjs`; the mode
manager — `tests/mode.mjs`). **Decision: keep the mode system; do not rip it out.**

- Click-to-type direct edits and the block `/` prompt remain **Edit-mode** behaviors (unchanged
  gating: `mode==='edit' && !activeView && !modifyMutex`). This already delivers "click anywhere
  and type" once in Edit mode (E0).
- The **document-level `/`** (R4) and **selection `/`** (R3) are wired at the document keydown
  level and are available whenever the document is interactive (not under an active view / not
  mid-modify), so "press `/` for the whole document" works from the reading surface too — which
  is the reference's feel without deleting View mode.

This is the reversible, lower-risk default. If the operator wants a true no-mode "always
editable on open," that's a small follow-up (default boot mode → edit) layered on top; it does
not change any of the gesture code below.

## 5. R6 — `//` literal slash

Add `//` as a literal-slash escape alongside the existing `\/`:
- In the block prompt: when `data-rwa-cmd` is on and the command span is exactly `/`, a second
  `/` collapses to one literal `/` and demotes to text (reference `handleKey` `//` branch).
- `\/` continues to work (C1b unchanged) — additive, no regression to existing muscle memory.
- Update `tests/inline-edit.mjs` C-group to pin **both** escapes.

## 6. Test plan (TDD — extend `tests/inline-edit.mjs`, add hooks as needed)

New group **G — selection-scoped model `/`** (jsdom, deterministic — canned `fetch`, like C3):
- G1: selection in one block + `/` opens a selection prompt (chip after the highlight; scope
  label names the block); Enter runs an anchored command whose instruction quotes the selection;
  the `/…` text is never committed; `data-rwa-id` preserved; `surface:'anchored-command'`.
- G2: multi-block selection + `/` opens the docked bar (scope "N blocks"); Enter runs `modify()`
  with the spanned block ids + quoted selection; one commit, one undo.
- G3: a selection that includes a frozen block excludes it from the target set (frozen wall).
- G4: doc-level `/` with nothing focused opens the whole-doc lens (R4).
- G5: doc-level `/` with a selection opens the selection bar, not the whole-doc lens.

Extend group **C — escapes**:
- C6: `//` collapses to a literal `/` and commits it (mirror of C1b for the new convention).

Everything in groups S/E/C1–C5 must stay green (no regression). Browser-verify the real
gestures (jsdom can't exercise contenteditable Range/selection faithfully — the WYSIWYG memory:
"test hooks are jsdom-gated; browser-verify via real UI").

## 7. Invariants preserved (flag if any is touched)

- Bootstrap byte-identical except `INLINE_DOC`. Runtime never in IDB, never agent-visible.
- Frozen wall intact — no gesture instructs a frozen block; no `frozenBypass`.
- `data-rwa-id` preserved through every commit; reserved substrings never emitted.
- One gesture → one commit → one ⌘Z. Direct text = no model call.
- Regenerate references (`node tools/regenerate-refs.mjs`) after the seed change; run the full
  seed suite + conformance.

## 8. Resolved against the seed map (2026-07-07)

Confirmed: no existing selection-scoped *model* path (selection → deterministic formatting bar
only). Concrete wiring decisions:

- **Docked prompt surface = `#rwa-pal`** (the ⌘K palette: input + Enter → `modify`, `openPal`
  at ~2236, Enter handler ~1899-1915). R4 is `openPal()` with no scope. R3 threads an optional
  `palScope = {kind:'selection', entries, ids, text, label}`; the palette shows a scope chip and
  Enter routes to `runSlashScope` instead of plain `modify`. **Deliberate deviation from the
  reference:** single-block selection uses the same docked bar (not an inline chip) — simpler,
  no contenteditable-Range surgery, fully testable, same capability ("targets exactly that
  selection").
- **`runSlashScope(scope, instruction)`:** doc → `modify(instruction)`; selection single-block →
  `runAnchoredCommand(entry, augment)`; selection multi-block → `modify(augment, {scope})`.
  `augment` constrains the instruction to the quoted selection (§3).
- **Doc-level `/` keydown** added beside the ⌘K handler (~10127). Only meaningful when nothing
  editable is focused (`activeElement` not contenteditable/input/textarea) and no pal/lens open.
  With a non-collapsed selection **and** Edit-ready → selection scope (never re-renders, so the
  selection survives). With no selection → force Edit mode (mirroring ⌘K) + whole-doc scope.
- **`//` symmetric to `\/`:** `commandStartIndex` (4209-4217) ignores a word-boundary `/`
  immediately followed by `/`; `commitInlineEdit` (4387) strips one slash from a word-boundary
  `//`, exactly as it already strips the `\/` backslash. Both escapes coexist.
- **`selectionLeafEntries()`** new helper: editable leaves intersecting the selection (via
  `compareBoundaryPoints`, jsdom-safe), minus frozen/`.rwa-locked`, mapped to sourceMap entries.
- **Mode:** kept. R3 = Edit-mode; R4/`⌘K`/`/` auto-enter Edit. Default boot mode unchanged
  (read-first); flipping to always-editable-on-open is a one-line operator follow-up.

## 9. Browser verification (the jsdom gap)

jsdom approximates contenteditable + Selection but does not render or produce real native
cross-block selections, and it can't prove that `/`'s `preventDefault` stops the keystroke from
typing. Manual recipe (open a real Chromium on the regenerated `hello.html`):

1. Click **Edit** in the status bar.
2. Type into a paragraph — text edits directly, no model call. Type `and/or`, `6/7`, `http://x` —
   the slashes stay literal. Type `//note` and commit — it collapses to `/note`.
3. Put the caret mid-paragraph and type `/shorten this` → the suffix turns into a block
   instruction (colored `/…`); Enter runs it on that block.
4. Select a phrase in one paragraph, press `/` → the docked prompt opens with a "Selection · 1
   block" chip; type an instruction, Enter → only that phrase changes.
5. Drag a selection across two/three paragraphs, press `/` → "Selection · N blocks"; Enter → the
   change lands only on the selected span.
6. Click into empty space (nothing focused), press `/` → the whole-document prompt opens.

Expected: no stray `/` characters typed anywhere the gesture fires; one ⌘Z reverts each edit.
