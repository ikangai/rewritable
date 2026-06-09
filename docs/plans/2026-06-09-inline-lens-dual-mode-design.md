# Inline lens — dual-mode editing design

Date: 2026-06-09
Status: design (not yet implemented)
Author: brainstormed with the project author

## The problem

The lens (`⌘K` → floating prompt card) and the inline manual edit (double-click a
block → type directly) are two separate places. **Switching to the lens breaks the
editing flow.** Concretely: deleting a sentence by hand is far faster than telling
the LLM to do it, yet the moment you want the LLM you have to leave the text, find
the floating card, and address a target the card can't see you pointing at.

The author's framing: editing should have one surface where direct manipulation
(keyboard) and instructing the LLM live together, with no mode trip. The original
idea floated voice as the second channel; the analysis below shows the foundational
fix is collapsing the *location* of the prompt, and voice is a later input method
into that same surface — not a parallel channel.

## Why not voice-first (idea rejected as the foundation)

Voice + keyboard simultaneously was the first idea. It has a foundational tension
with what a rewritable is:

- **No self-contained STT.** A rewritable is one file, no server, no build, cdnjs
  only when needed. Chrome's `SpeechRecognition` sends audio to Google's servers —
  that quietly breaks the offline + privacy story. In-browser Whisper is a multi-MB
  WASM download. Neither is honest for a "self-contained" file.
- **Voice has no pointer.** "Make *this* formal" — *this* needs a selection. So the
  real shape is "mouse selects + voice instructs": voice is an input method into a
  prompt, not a parallel channel.
- **Voice isn't always usable** (office, library, train). It can't be the only path.

So voice is designed-for, deferred in build. See "The voice seam" below.

## The design: the lens becomes inline

One surface, one physical vocabulary. **Select what you want changed, then talk to
it.**

### Gesture grammar

| Gesture | Result |
|---|---|
| **Single-click** a leaf block | Enter edit: caret lands, type directly (today's inline-edit path) |
| **Type** | Direct manipulation — no LLM. Commits on blur/⌘S via `user:edit-surface`. |
| **Select** (caret or range) | *Is* the target. No separate "anchor" gesture anymore. |
| **`/`** (or **⌘K**) | Open a prompt **attached to the current selection** |
| **Enter** in prompt | Execute the LLM edit, scoped by the selection |
| **Esc** | Cancel — text untouched |

The unifying insight: **if the prompt renders at the selection, anchoring becomes
implicit.** Today single-click anchors a block so the floating lens knows its
target. With the lens inline, *the selection IS the target* — anchor and scope
collapse into one concept (what you've selected). This is the author's original
"selection with the mouse" intuition returning as the core mechanism.

`/` and `⌘K` are **twin invocations** of the same inline prompt — `/` for the
typing-flow hand, `⌘K` for the keyboard-first hand. The floating card stops floating
and renders at the selection; no muscle memory is lost.

### Scope = selection extent (three tiers)

Scope falls straight out of the selection — no keywords to memorize:

- **Range inside one block** ("make *this sentence* formal") → the selected
  substring is the edit target. New capability; the author's "delete a sentence"
  example, LLM-powered, surgically bounded.
- **Collapsed caret** in a block → that whole block.
- **Range across blocks / select-all** → multi-block or document, via the full
  `modify()` loop.

### Command-mode mechanics (the `/` trigger)

`/` is typed *into the text* (Notion-style); the `/…` text is a command, not
content, and the document bytes are untouched until commit. Disambiguation rule:

> **`/` enters command mode only when it is the first non-whitespace character of
> the edit, or is immediately preceded by whitespace. `/` followed immediately by a
> space reverts to a literal slash.**

This clears every real collision:

- `and/or`, `06/09`, `https://` → `/` preceded by letter/digit/colon → **literal**.
- `a / b / c` → would trigger, but `/`+space (or Esc) reverts → **literal**.
- `/make this formal` at start → **command**.

In command mode the `/…` text is styled distinctly (tint + a ✦ gutter glyph) so you
always know you're addressing the LLM. **Enter** executes; **Esc** reverts to
literal text.

**The one place this bends:** if a *range* is selected and you type `/`, normal
editing would replace the selection. So in the range case `/` is **intercepted**,
the range is kept as scope, and the command input floats at the selection edge:

- **Collapsed caret** → `/` lives inline in the text (pure typed-command).
- **Range selected** → `/` intercepted, input floats at the selection.

Same key, same mental model; rendering follows what's physically possible.

## Two commit paths, one undo stack

Direct typing and LLM edits travel different machinery in this codebase; the design
keeps them distinct rather than blurred.

**Direct typing** is unchanged: leaf-only, shape-preserving, committed through
`runtimeApplyEnvelope` as actor `user:edit-surface`, one `rwa_undo` frame on
blur/⌘S.

**A slash edit routes by scope** onto the existing tool ladder:

- **Range inside a block** → `apply_edits` with the *selected substring as the
  anchor* — tightest possible edit, can't escape the selection.
- **Collapsed caret** → the block is context; `modify()` may restructure within it.
- **Multi-block / select-all** → full `modify()` loop, free tool choice
  (`apply_dsl_plan` → `apply_edits` → `replace_document`).

Either way it lands **one** `rwa_undo` frame, actor-tagged (`lens:inline` or the
model id). `⌘Z` behaves uniformly regardless of how a change was made.

### The flush-then-prompt ordering

`modify()` reads the *committed* doc from IDB. If you've typed direct edits and not
committed, then hit `/`, the LLM would miss your unsaved keystrokes. The fix: on
`/`, **first commit the pending inline edit** (its own `user:edit-surface` frame),
**then** run the LLM edit (a second frame).

A slash-after-typing therefore produces **two** undo steps, not one — deliberately.
Each frame is a real, separately-authored change with an honest actor (your hand,
then the model). Folding them into one commit would forge single authorship over two
authors and muddy the audit trail. Fail-loud over tidy.

**`modify()` itself needs zero changes.** All new behavior lives in the edit surface
deciding scope and which committed doc to hand off.

## The voice seam (designed-for, deferred)

Because the prompt is now one buffer attached to the selection, voice becomes a
third *fill method* for that buffer — not a parallel channel, not always-on. The
seam: a push-to-talk affordance (hold a key / tap a mic glyph on the inline prompt)
that streams transcription into the prompt text, which you still confirm with Enter.
This keeps "selection + voice" intact and dodges both traps: no always-on mic, and
`this` is never ambiguous because the selection already scoped it.

Implementation is deferred (the STT-phones-home problem is unsolved for a
self-contained file — likely an opt-in, clearly-disclosed `SpeechRecognition` path,
gated so the file stays honest when off). Designing the buffer right now makes voice
additive later, not a rewrite.

## What changes

- `seeds/rewritable.html` — the inline-edit block (`commitInlineEdit` /
  `handleMountDblClick` / `serializeLeafSafe`) grows the `/` trigger + command-mode
  rendering; the lens stops floating and renders at the selection; single-click
  becomes edit-entry; selection→scope routing.
- `modify()` — **unchanged**.
- Specs: `docs/specs/rwa-lens-spec.md` §5.1 (click-semantics + floating→inline is a
  real model change) and this design's companion in the inline-edit design doc.
- CLI: unaffected — runtime/surface change, not an edit-protocol change.
- Tests: extend `tests/inline-edit.mjs` + `tests/view.mjs`; pin the `/`
  disambiguation rule and the flush-then-prompt ordering.
- Regenerate references (`node tools/regenerate-refs.mjs`) after the seed change.

## Out of scope (YAGNI)

- Voice *implementation*.
- A slash *menu* of canned commands — the prompt is free-text.
- Any change to the edit protocol, commit atomicity, or `modify()`.

## Open questions for implementation

- Exact visual treatment of the inline prompt at each scope tier (caret / range /
  doc) — needs a real-browser pass, jsdom won't tell us.
- Whether double-click retains a distinct role (word-select vs redundant with
  single-click edit-entry).
- Where the doc-scope prompt anchors when the selection is select-all but the
  viewport is scrolled.
