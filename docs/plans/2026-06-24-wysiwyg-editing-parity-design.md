# WYSIWYG editing parity + unobtrusive chrome — design

Date: 2026-06-24
Goal (from the user): unobtrusive menu + WYSIWYG editing for **document** and
**presentation** rwas, at **feature/UX parity with https://heyhtml.com**, plus
seamless **Notion-style `/`-prompt LLM** (Esc cancels). Drag-drop image inlining matters.

## The parity target (heyhtml.com)

- **Double-click any text → inline edit in place** (we have this — `contenteditable`
  leaf-text editing, actor `user:edit-surface`).
- **Select text → a floating toolbar appears** with: bold, italic, headings (H1–H6),
  fonts, colors, alignment, line-height, text-transform. *This is the core gap.*
- **Right-click → insert panel** (tables, images, dividers, buttons).
- **Paste / drag-drop images** (we have this — images-v1).
- **No AI.** heyhtml is pure visual editing → our seamless `/`-prompt LLM is *our*
  differentiator, layered on the same surface (Notion-style).

## What already exists (don't rebuild)

- **Inline manual edit** — leaf click in Edit mode → `contenteditable`; Enter/blur
  commit via `runtimeApplyEnvelope`→`commitCore`, `surface:'inline-edit'`, one ⌘Z.
  Editable set = `ANCHORABLE_TAGS` (`p`/`h1-6`/`blockquote`/`li`/`td`).
  (`docs/plans/2026-06-08-inline-manual-edit-design.md`.) **Inline formatting was
  explicitly out of scope there** — that deferral is what we now close.
- **Selection command bar** (`#rwa-selection-bar`) — selecting text in one leaf block
  opens a runtime-only bar; deterministic `bold`/`italic`/`code` compile locally to
  `rwa-edit/1` and commit via the non-agent path, `surface:'selection-edit'`,
  `actor:'user:selection-command'`; a typed/voice command + LLM fallback; occurrence-
  accurate (`resolveSelectionCommandTarget`/`runSelectionCommand`). (lens spec §5.1.)
- **`/`-prompt** — a leading `/` inside an inline edit flips to a block-scoped agent
  command (`runAnchoredCommand`, `surface:'anchored-command'`); Esc demotes to literal,
  blur discards. (`docs/plans/2026-06-09-inline-lens-dual-mode-design.md`.) Notion-style
  already — verify discoverability/seamlessness.
- **Images** — drag/drop/paste/picker insert + hover S/M/L resize, Edit-mode-gated,
  non-agent commit path (`rwa-edit-spec.md §19`, lens §6.3).
- **Mode manager** — `runtime.mode`/`setMode`/`on('mode')`; Document/Edit/Skills/Actions.
- **Chrome** — a row of status-bar buttons (`rwa-st-status ● ready`, `ⓘ`, `⚙`, `✦`,
  `↗`, `⌘S`) in `#rwa-runtime`, plus the mode panel.

So the spine is built. This work is **parity + polish + consolidation**, not greenfield.

## Gap analysis → increments

The single biggest parity gap is a **real formatting toolbar on selection**. The
selection bar exists but exposes only 3 inline commands + a text prompt. heyhtml exposes
headings, color, alignment, etc. as *direct controls*. The existing
`runSelectionCommand` machinery (deterministic compile → `rwa-edit/1` → non-agent commit)
is exactly the right substrate to extend — same commit path, same occurrence mapping,
same actor family, same tests style. We add **compilers + buttons**, not a new engine.

Two formatting scopes (both already expressible in `rwa-edit/1`):
- **Inline** (wrap the selected occurrence): bold `<strong>`, italic `<em>`,
  underline `<u>`, strikethrough `<s>`, inline code `<code>`, link `<a href>`,
  text color (`<span style="color:…">`). Today's bold/italic/code are this shape.
- **Block** (retag / restyle the containing leaf block): heading level
  (`p`↔`h2`/`h3`), alignment (`style="text-align:…"` on the block). Targets the whole
  block like the anchor model.

### Increment 1 — Bubble formatting toolbar (the parity core)

Turn `#rwa-selection-bar` into a **floating bubble** positioned above the selection
(like heyhtml/Notion), exposing direct controls:
- **Block:** a heading control (Paragraph / H1 / H2 / H3) + alignment (left/center/right).
- **Inline:** Bold, Italic, Underline, Strikethrough, Code, Link, Text color (swatch).
- Keep the typed/voice command input + the LLM affordance (our differentiator), collapsed
  behind a `/`-style entry so the bar stays unobtrusive.
All deterministic, instant, no API call — each maps to a `rwa-edit/1` compile committed
via the non-agent path (`surface:'selection-edit'`). Active-state highlight when the
selection is already bold/H2/etc. Pinned by extending `tests/inline-edit.mjs` (E-blocks).

### Increment 2 — Unobtrusive chrome

Collapse the button row into a single quiet affordance: a small floating control that
expands to the menu (settings/info/skin/share) on click, with **⌘S surfaced only when
dirty**. Keep mode + ⌘S reachable; tuck the rest. Verify nothing in `tests/view.mjs`/
`tests/mode.mjs` regresses (active-view inertness, mode gating).

### Increment 3 — Slash-prompt seamlessness + presentation parity

Polish `/`-prompt discoverability (a hint placeholder on empty edit), confirm Esc/blur
semantics match Notion, and confirm the bubble toolbar + inline edit work inside the
**presentation** kind's slides (per-slide leaf editing, nav unaffected).

## Constraints (load-bearing)

- **Single-file, no deps, no build.** All inline in the seed. Deterministic formatting
  is local (no model); the LLM is opt-in via the prompt entry only.
- **Non-agent commit path only** — reuse `runtimeApplyEnvelope`/`commitCore`; never a new
  apply/validator. One ⌘Z per formatting action. Frozen zones + structural guards still
  apply (the apply pipeline is the schema).
- **Edit-mode-gated** — formatting/inline-edit only when `mode==='edit' && !activeView &&
  !modifyMutex`; runtime chrome only (`data-rwa-no-inline-edit`).
- **Occurrence-accurate** — reuse `resolveSelectionCommandTarget`'s mapping so repeated
  words target the selected occurrence.
- **Seed-only**, regenerate refs after; mirror nothing to CLI (this is GUI).

## Build order

Increment 1 first (biggest parity win), TDD against `tests/inline-edit.mjs`, browser-
verify the bubble in real Chromium (positioning/active-state are UX, jsdom can't judge).
Then 2, then 3. Each increment: design-confirm → TDD → browser-verify → commit.

## Confirmed current-state references (seed survey, 2026-06-24)

Selection surface (extend this): `#rwa-selection-bar` markup ~L1520–1525 (`#rwa-selection-bold`
/`#rwa-selection-cmd`/`#rwa-selection-run`/`#rwa-selection-voice`), CSS L193–200/209;
`resolveSelectionCommandTarget()` L3380 → `{el,entry,text,occurrence,range}`;
`parseSelectionCommand()` L3435 (only bold→`<strong>`/italic→`<em>`/code→`<code>`);
`applySelectionWrap()` L3444 (inline wrap → `runtimeApplyEnvelope`); `runSelectionCommand()`
L3472; `positionSelectionCommandBar()` L3488; `refreshSelectionCommandBar()` L3503;
`startSelectionVoice()` L3522.
Block-level pattern to mirror: `commitInlineEdit()` L3775 (rebuild a leaf block via envelope);
`swapFigureSizeClass()` L4108 (regex-rewrite a block's open tag → small commit) — the model
for alignment. Inline-edit entry gating L1238–1244/L3829. Editable set `INLINE_EDITABLE` L3315.
Chrome: `buildUI()` L1469, container `#rwa-set` L43, mode tabs `#rwa-mode-tabs`,
`setDirty()` L1881. Presentation: `presentationProvider` L8120, nav `#rwa-view-chrome` L8159.

**Confirmed: no font-size / heading / link / alignment / color / underline / strikethrough
controls exist** — only the 3 inline wraps + the LLM prompt. That is exactly the parity gap.
