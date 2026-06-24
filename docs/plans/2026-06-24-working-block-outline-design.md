# Working-block outline — "the block I'm working on" (2026-06-24)

## Problem

The black anchor outline (`data-rwa-anchored`) drifted onto the *previous* block while
editing. Five patches each fixed one symptom and surfaced another. Instrumented logging in a
real browser showed the root: the `editing=` block and the `OUTLINE=` block were **never the
same** — switching blocks is not atomic. Clicking a new paragraph runs a lag-prone sequence
(old block exits → blurs → commits → re-renders → new block anchors via a *separate*
`handleMountClick` path), and those steps race, so the cursor and the outline land one block
apart. The coupling between inline-edit, click-anchor, blur, and commit-render is the wrong
architecture, not any single line.

## Decision (user-chosen)

**One concept: "the block I'm working on."** The block your caret is in owns the cursor, the
black outline, and the ⌘K AI target — all derived from a single source of truth (`inlineEdit`),
and switching blocks is **one click**.

## Design

1. **Outline + lens are derived from `inlineEdit`, set at the entry/exit points only.**
   - `enterInlineEdit(el, entry)` → `anchorTo(entry)` (outline on `el`, lens moves under it,
     badge shows, `lensState.anchor = entry` so ⌘K acts on the working block).
   - `exitInlineEdit()` → `releaseAnchor()` (clears outline + lens).
   - No other path sets the editable-leaf outline. `handleMountClick` no longer anchors while
     `inlineEdit` is set — it only anchors **non-editable containers** (figure/pre/aside/table),
     which have no inline edit.

2. **One-click switch (atomic).** `startInlineEditFromEvent` no longer bails when already
   editing. Clicking a different editable leaf:
   - **clean (old block unchanged):** `exitInlineEdit()` (no commit, no re-render) →
     `enterInlineEdit(new)`. Synchronous, one click, outline follows.
   - **dirty (old block edited):** record the target's *ordinal* first, `commitInlineEdit()`
     (re-renders), then re-resolve the target by ordinal in the rebuilt DOM and enter it. The
     ordinal is stable because committing a leaf changes its text, not the block order.
   - Clicking the block you're already in is a no-op (caret move).

3. **Drag-select** stays consistent: pointerdown opens inline edit on the block, so the block
   you're selecting in is the working block and carries the outline; the formatting toolbar
   shows on the selection. No separate "selection anchor" — the toggle bug can't recur because
   the outline tracks `inlineEdit`, not a click/selection race.

## Why this removes the races

The outline has exactly one writer (`anchorTo`/`releaseAnchor` via `enterInlineEdit`/
`exitInlineEdit`) and one source of truth (`inlineEdit`). There is no second path
(`handleMountClick`) competing during a switch, and the switch commits-then-enters in a single
ordered step, so the cursor and outline can never land on different blocks.

## Tests

- `tests/inline-edit.mjs`: entering a block outlines it; **switching** to another block in one
  pointerdown moves the outline atomically (new block outlined, previous not, exactly one);
  exiting clears it; a no-op double-enter on the same block keeps a single outline.
- `tests/lens.mjs`: deliberate container anchor + release still clear all outlines (L5.1e).
- Browser repro: click straight down paragraphs without Enter — outline follows every click.
