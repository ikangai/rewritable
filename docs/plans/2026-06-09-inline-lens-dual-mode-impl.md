# Inline-lens dual-mode — Increment 1 implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Inside the existing double-click inline edit, typing `/` at the start of a
block lets you instruct the LLM about that block and run it with Enter — no trip to
the floating lens.

**Architecture:** Add a command-mode layer on top of the existing inline-edit
surface (`enterInlineEdit`/`handleInlineKeydown`/`commitInlineEdit` in
`seeds/rewritable.html`). When the editable's text begins with `/`, the block enters
*prompt mode* (visual only, reusing the lens's `data-mode='command'` styling). Enter
routes to the **existing** `runAnchoredCommand(entry, instruction)` — the lens's
block-scoped agent path — instead of committing the typed text. Esc demotes prompt
mode back to literal text. No new agent/commit machinery; this is wiring + a small
keydown/input layer.

**Tech stack:** Plain inline JS in the seed bootstrap. Tests: jsdom +
fake-indexeddb (`tests/inline-edit.mjs` pattern). No build step.

**Design doc:** `docs/plans/2026-06-09-inline-lens-dual-mode-design.md`

**Scope boundary (Increment 1 only):**
- IN: `/`-at-start prompt mode, Enter → `runAnchoredCommand`, Esc demote, failure
  restore, frozen safety, docs.
- OUT (later increments): single-click-to-edit (changing the documented anchor
  gesture), selection-substring scope, doc-scope from the inline surface, the lens
  visually relocating to the selection, voice.

**Stated semantics (confirm if wrong):** prompt mode requires the block to *begin*
with `/` (leading whitespace ignored). The mid-content "edit text, then append
`/prompt`" case is deferred (needs a content/command split that is fiddly in
contenteditable). The `/…` text is never committed as content — `runAnchoredCommand`
edits the block's *committed* source, so clearing a block to type a prompt never
destroys it.

---

## Key existing code (read before starting)

- `seeds/rewritable.html:2595` — `INLINE_EDITABLE` set.
- `seeds/rewritable.html:2616` — `enterInlineEdit(el, entry)` / `exitInlineEdit()`
  (attaches `keydown`/`blur`/`paste`; captures `inlineEdit = {el, entry, original}`).
- `seeds/rewritable.html:2680` — `handleInlineKeydown(e)` (Enter→commit,
  Shift+Enter→soft break, Esc→`revertInlineEdit`).
- `seeds/rewritable.html:2704` — `commitInlineEdit()` (non-agent leaf commit, actor
  `user:edit-surface`).
- `seeds/rewritable.html:2745` — `handleMountDblClick(e)` (frozen gates at 2752,
  2759; calls `enterInlineEdit`).
- `seeds/rewritable.html:3858` — `runAnchoredCommand(anchor, instruction)` — REUSE.
  Holds `modifyMutex`, single-shot agent (3 retries), commits via `applyEdits` with
  `surface:'anchored-command'`, `scope:{type:'block'}`, re-anchors post-commit.
  Returns (no throw) on retry-exhaustion WITHOUT re-rendering.
- `seeds/rewritable.html:1338` — the lens's `input` listener sets
  `lensEl.dataset.mode = isCommand ? 'command' : 'text'` (`v.startsWith('/') &&
  !v.startsWith('\\/')`). Mirror the detection; reuse the CSS contract.
- `seeds/rewritable.html:3744` — `callAgentSingleShot` → `openAiCompatChat` →
  `window.fetch` (stub in tests).
- `tests/inline-edit.mjs` — harness: jsdom + fake-indexeddb, `window.fetch` throws,
  `$id`, `dbl(el)`, `readHistTop()`, `readUndoLen()`, `window.__setDocForTest(html)`,
  `window.getDoc()`, `settle()`.

**Before writing code, verify these two facts (Rule 8):**
1. Read `runAnchoredCommand` 3858→end: confirm (a) the retry-exhaustion tail does
   NOT call `renderDoc` (so the caller must restore the DOM on failure), and (b) it
   reads the anchor via `resolveAnchorFind(anchor)` + `anchor.start` (properties, not
   identity) so a captured `entry` survives an intervening `renderDoc`.
   *[CORRECTED during implementation: (b) is wrong — `resolveAnchorFind` matches the
   entry by **reference identity** against the current `sourceMap`, which `renderDoc`
   rebuilds, so a captured `entry` does NOT survive an intervening re-render. The
   shipped fix: `runInlineCommand` captures the entry's ordinal
   (`sourceMap.indexOf(entry)`) before `renderDoc` and re-resolves `sourceMap[idx]`
   after — same committed bytes → identical rebuilt map → same index.]*
2. Read `openAiCompatChat` to confirm the response shape it reads
   (`data.choices[0].message.content`) so the canned `fetch` stub is correct.

---

## Task 0: Baseline

**Step 1:** In the worktree, `cd tests && npm install` (already done if node_modules
present).

**Step 2:** Run baseline and confirm green:

```
node inline-edit.mjs   # expect "40 pass, 0 fail"
node view.mjs          # expect "19 pass, 0 fail"
```

Expected: both pass. If not, STOP and report.

---

## Task 1: Prompt-mode detection + visual state

**Files:**
- Modify: `seeds/rewritable.html` — `enterInlineEdit` (~2616) and `exitInlineEdit`.
- Test: `tests/inline-edit.mjs` (append a new block).

**Step 1: Write the failing test.** Append to `tests/inline-edit.mjs`:

```javascript
console.log('\n== C1: prompt mode toggles on leading slash ==');
{
  await window.__setDocForTest('<p data-rwa-id="c1aaaaaa">Original text</p>');
  const el = $id('c1aaaaaa');
  dbl(el);
  check('entered inline edit', el.getAttribute('contenteditable') === 'true');
  // not a command yet
  check('plain text → not command mode', el.dataset.rwaCmd !== 'on');
  // simulate clearing + typing a slash command
  el.textContent = '/make it bolder';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('leading slash → prompt mode on', el.dataset.rwaCmd === 'on');
  // remove the slash → back to text
  el.textContent = 'make it bolder';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('no leading slash → prompt mode off', el.dataset.rwaCmd !== 'on');
  window.revertInlineEdit();
}
```

**Step 2: Run, verify it fails.**
`node inline-edit.mjs` → FAIL at "leading slash → prompt mode on" (no `rwaCmd`
handling yet).

**Step 3: Implement.** In `enterInlineEdit`, after the existing listener attaches,
add an `input` listener and store it on `inlineEdit` so `exitInlineEdit` can remove
it. Detection mirrors the lens (`seeds/rewritable.html:1340`):

```javascript
// inside enterInlineEdit, alongside the keydown/blur/paste listeners:
el.addEventListener('input', handleInlineInput);
// ... and in the inlineEdit state object, ensure: commandMode:false, demoted:false
```

Add the handler near `handleInlineKeydown`:

```javascript
function isSlashCommand(text) {
  // leading whitespace ignored; a lone "/" or "/ " is not yet a runnable command
  // but still shows prompt mode (matches the lens's data-mode behavior)
  const t = text.replace(/^\s+/, '');
  return t.startsWith('/') && !t.startsWith('\\/');
}
function handleInlineInput() {
  if (!inlineEdit) return;
  if (inlineEdit.demoted) { setInlineCmd(false); return; }
  setInlineCmd(isSlashCommand(serializeLeafSafe(inlineEdit.el)));
}
function setInlineCmd(on) {
  if (!inlineEdit) return;
  inlineEdit.commandMode = !!on;
  if (on) inlineEdit.el.dataset.rwaCmd = 'on';
  else delete inlineEdit.el.dataset.rwaCmd;
}
```

In `exitInlineEdit`, remove the listener and clear the attribute:

```javascript
el.removeEventListener('input', handleInlineInput);
delete el.dataset.rwaCmd;
```

Expose for tests if needed (near `window.commitInlineEdit`):
`window.revertInlineEdit = revertInlineEdit;` (only if not already exposed — check
first).

**Step 4: Run, verify pass.** `node inline-edit.mjs` → all pass incl. C1.

**Step 5: Commit.**
```bash
git add seeds/rewritable.html tests/inline-edit.mjs
git commit -m "feat(seed): inline-edit prompt-mode detection on leading slash" \
  -- seeds/rewritable.html tests/inline-edit.mjs
```

---

## Task 2: Esc demotes prompt mode; second Esc reverts

**Files:**
- Modify: `seeds/rewritable.html` — `handleInlineKeydown` (~2680).
- Test: `tests/inline-edit.mjs`.

**Step 1: Write the failing test.**

```javascript
console.log('\n== C2: Esc demotes command mode, second Esc reverts ==');
{
  await window.__setDocForTest('<p data-rwa-id="c2aaaaaa">Keep me</p>');
  const el = $id('c2aaaaaa');
  dbl(el);
  el.textContent = '/usr/local';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('prompt mode on before Esc', el.dataset.rwaCmd === 'on');
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('first Esc demotes (still editing)', el.getAttribute('contenteditable') === 'true');
  check('first Esc clears prompt mode', el.dataset.rwaCmd !== 'on');
  // typing more slashes must NOT re-enter command mode this session
  el.textContent = '/usr/local/bin';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  check('demoted: leading slash stays literal text', el.dataset.rwaCmd !== 'on');
  // second Esc reverts the edit entirely (existing behavior)
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  check('second Esc reverted edit (not editable)', el.getAttribute('contenteditable') !== 'true');
  const doc = await window.getDoc();
  check('revert kept original content', doc.includes('Keep me'));
}
```

**Step 2: Run, verify it fails** at "first Esc demotes" (Esc currently always
reverts).

**Step 3: Implement.** In `handleInlineKeydown`, make Escape context-sensitive:

```javascript
} else if (e.key === 'Escape') {
  e.preventDefault();
  if (inlineEdit.commandMode) {
    inlineEdit.demoted = true;
    setInlineCmd(false);   // keep the "/…" as literal text, stay in the edit
  } else {
    revertInlineEdit();
  }
}
```

**Step 4: Run, verify pass.**

**Step 5: Commit.**
```bash
git add seeds/rewritable.html tests/inline-edit.mjs
git commit -m "feat(seed): Esc demotes inline prompt mode, second Esc reverts" \
  -- seeds/rewritable.html tests/inline-edit.mjs
```

---

## Task 3: Enter runs the command via runAnchoredCommand

**Files:**
- Modify: `seeds/rewritable.html` — `handleInlineKeydown` + new `runInlineCommand`.
- Test: `tests/inline-edit.mjs`.

**Step 1: Write the failing test.** Stub `window.fetch` to return a canned
completion (naked HTML is what `runAnchoredCommand` expects from the agent):

```javascript
console.log('\n== C3: Enter in prompt mode runs the agent on the block ==');
{
  await window.__setDocForTest('<p data-rwa-id="c3aaaaaa">plain sentence</p>');
  const el = $id('c3aaaaaa');
  dbl(el);
  el.textContent = '/make it bold';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  // canned agent reply: naked replacement HTML for the block body
  const realFetch = window.fetch;
  window.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: '<strong>plain sentence</strong>' } }] }),
  });
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await window.waitFor
      ? await window.waitFor(async () => (await window.getDoc()).includes('<strong>'))
      : await settle();
    await settle();
    const doc = await window.getDoc();
    check('block edited by the agent', doc.includes('<strong>plain sentence</strong>'));
    check('the "/command" text was NOT committed as content', !doc.includes('/make it bold'));
    check('data-rwa-id preserved', doc.includes('data-rwa-id="c3aaaaaa"'));
    const top = await readHistTop();
    check('hist surface is anchored-command', top && top.surface === 'anchored-command');
  } finally {
    window.fetch = realFetch;
  }
}
```

> Note: if `tests/inline-edit.mjs` has no `waitFor`, use a small poll loop (see
> `view.mjs:waitFor` lines 56–61) or a few `await settle()` cycles — the agent path
> awaits a (stubbed) fetch + IDB write. Prefer a poll on `getDoc()` over fixed
> sleeps (Rule 9: deterministic).

**Step 2: Run, verify it fails** (Enter currently commits the literal `/make it
bold` as content).

**Step 3: Implement.** Route Enter in `handleInlineKeydown`:

```javascript
if (e.key === 'Enter' && !e.shiftKey) {
  e.preventDefault();
  if (inlineEdit.commandMode) {
    runInlineCommand();   // fire-and-forget; UX handled inside
  } else {
    commitInlineEdit().catch(() => {});
  }
}
```

Add `runInlineCommand` near `commitInlineEdit`:

```javascript
// Run a slash command typed inside an inline edit against the current block,
// reusing the lens's block-scoped agent path. The typed "/…" text is the
// instruction and is NEVER committed as content — runAnchoredCommand edits the
// block's committed source. Fail-loud: restore the last-good render on error.
async function runInlineCommand() {
  if (!inlineEdit) return;
  const { entry } = inlineEdit;
  const instruction = serializeLeafSafe(inlineEdit.el).replace(/^\s*\/\s?/, '').trim();
  exitInlineEdit();                 // discard the "/…" DOM text; do not commit it
  renderDoc(currentDocCache);       // restore the original block immediately
  if (!instruction) return;         // lone "/" → no-op (block already restored)
  try {
    await runAnchoredCommand(entry, instruction);
  } catch (err) {
    renderDoc(currentDocCache);
    if (typeof setStatus === 'function') setStatus('err', '✗ ' + (err && (err.code || err.message)));
  }
}
window.runInlineCommand = runInlineCommand; // expose for tests
```

> Why `renderDoc(currentDocCache)` before the agent call: `exitInlineEdit` only
> strips contenteditable — the DOM still shows the typed `/…`. Restoring first means
> that if the agent declines/exhausts retries (which returns without re-rendering),
> the block is already back to its committed content. On success,
> `runAnchoredCommand` re-renders again (harmless).
> Confirm in Task-0 verification that `runAnchoredCommand` reads the anchor by
> `anchor.start`/`resolveAnchorFind`, so the captured `entry` is still valid after
> this `renderDoc`.
> *[CORRECTED during implementation: the captured `entry` is NOT still valid —
> `resolveAnchorFind` is reference-identity vs the current `sourceMap`, and
> `renderDoc` rebuilds the map. The shipped `runInlineCommand` records
> `sourceMap.indexOf(entry)` before `renderDoc` and re-resolves the same ordinal
> from the rebuilt map afterwards.]*

**Step 4: Run, verify pass.**

**Step 5: Commit.**
```bash
git add seeds/rewritable.html tests/inline-edit.mjs
git commit -m "feat(seed): Enter in inline prompt mode runs runAnchoredCommand on the block" \
  -- seeds/rewritable.html tests/inline-edit.mjs
```

---

## Task 4: Failure path restores the block (no orphaned "/command")

**Files:**
- Test: `tests/inline-edit.mjs` (the code already restores in Task 3; this PINS it).

**Step 1: Write the test.**

```javascript
console.log('\n== C4: agent failure restores the block, commits nothing ==');
{
  await window.__setDocForTest('<p data-rwa-id="c4aaaaaa">untouched</p>');
  const el = $id('c4aaaaaa');
  dbl(el);
  el.textContent = '/do something';
  el.dispatchEvent(new window.InputEvent('input', { bubbles: true }));
  const undoBefore = await readUndoLen();
  const realFetch = window.fetch;
  window.fetch = async () => { throw new Error('network down'); };
  try {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle(); await settle();
    const doc = await window.getDoc();
    check('original content intact', doc.includes('untouched'));
    check('no "/command" leaked into the doc', !doc.includes('/do something'));
    const undoAfter = await readUndoLen();
    check('no undo frame burned on failure', undoAfter === undoBefore);
    const live = $id('c4aaaaaa');
    check('live DOM shows original, not the /command', live && live.textContent === 'untouched');
  } finally {
    window.fetch = realFetch;
  }
}
```

**Step 2: Run.** Expected PASS (Task-3 code restores). If it FAILS — e.g.
`runAnchoredCommand`'s exhaustion path leaves the mutex held or does an unexpected
render — STOP, re-read 3858→end, and fix the restore in `runInlineCommand`
accordingly. Do not paper over with sleeps.

**Step 3: Commit.**
```bash
git add tests/inline-edit.mjs
git commit -m "test(seed): pin inline-command failure restores block, no commit" \
  -- tests/inline-edit.mjs
```

---

## Task 5: Frozen / locked safety

Frozen blocks never enter inline edit (`handleMountDblClick` gates at 2752/2759), so
a `/command` can't originate in one. This task PINS that invariant so a future
refactor can't regress it.

**Step 1: Write the test.**

```javascript
console.log('\n== C5: frozen block cannot enter inline edit (so no /command) ==');
{
  await window.__setDocForTest('<p data-rwa-frozen data-rwa-id="c5aaaaaa">locked</p>');
  const el = $id('c5aaaaaa');
  dbl(el);
  check('frozen block did not become editable', el.getAttribute('contenteditable') !== 'true');
  check('no prompt mode on a frozen block', el.dataset.rwaCmd !== 'on');
}
```

**Step 2: Run, verify pass** (should pass with no code change — it pins existing
gates). If it fails, the gate moved; STOP and reconcile.

**Step 3: Commit.**
```bash
git add tests/inline-edit.mjs
git commit -m "test(seed): pin frozen blocks stay out of inline prompt mode" \
  -- tests/inline-edit.mjs
```

---

## Task 6: Visual styling for inline prompt mode

**Files:**
- Modify: `seeds/rewritable.html` — CSS near the lens `data-mode` styles (~108–146)
  and/or the doc-mount block styles. Add a rule for `[data-rwa-cmd="on"]`.

**Step 1:** Add a minimal, theme-aligned rule (tint + a leading ✦ affordance). Keep
it `#rwa-doc-mount`-scoped and specificity-light so document styles still win:

```css
:where(#rwa-doc-mount) [data-rwa-cmd="on"] {
  background: var(--blue-50, #eef4ff);
  box-shadow: inset 2px 0 0 var(--blue, #2563eb);
  border-radius: 4px;
}
```

(Use the actual palette tokens present in the seed — grep `--blue` first; fall back
to the grayscale ramp if no blue-50.)

**Step 2:** This is visual; jsdom can't assert paint. Verify the attribute toggles
(already covered by C1) and do a real-browser check in Task 8.

**Step 3: Commit.**
```bash
git add seeds/rewritable.html
git commit -m "style(seed): inline prompt-mode visual affordance" -- seeds/rewritable.html
```

---

## Task 7: Specs, references, full suite

**Files:**
- Modify: `docs/specs/rwa-lens-spec.md` §5.1 — add the inline `/`-command note
  (block-scoped; reuses `runAnchoredCommand`; Esc demotes; `/`-at-start only in
  Increment 1). Bump the spec's trailing version line per its convention.
- Modify: `docs/plans/2026-06-08-inline-manual-edit-design.md` — cross-reference the
  new prompt-mode layer.
- Modify: `CLAUDE.md` routing entry for "Inline manual edit" — note the `/`-command
  prompt-mode layer + that it reuses `runAnchoredCommand`.

**Step 1:** Make the doc edits (surgical; match each file's voice).

**Step 2: Regenerate references** (the seed changed):
```bash
node tools/regenerate-refs.mjs
```
Verify `hello.html` / `re-write-able-spec.html` still differ only in
`DOC_UUID`/`INLINE_DOC` (the regen script enforces this).

**Step 3: Run the full relevant suite:**
```bash
cd tests
node inline-edit.mjs   # all C1–C5 + original 40 pass
node view.mjs          # 19 pass (inline-edit still inert under active view)
node lens.mjs          # ensure the lens path is untouched
```
Also run conformance (the seed changed):
```bash
cd ../benchmark && npm run conformance
```
Expected: all green. Report exact counts (Rule 12 — no "should pass").

**Step 4: Commit.**
```bash
git add docs/specs/rwa-lens-spec.md docs/plans/2026-06-08-inline-manual-edit-design.md CLAUDE.md hello.html re-write-able-spec.html
git commit -m "docs(spec): inline /-command prompt mode (rwa-lens §5.1) + regen refs" -- \
  docs/specs/rwa-lens-spec.md docs/plans/2026-06-08-inline-manual-edit-design.md CLAUDE.md hello.html re-write-able-spec.html
```

---

## Task 8: Real-browser verification (jsdom can't see paint or caret)

Open the modified `seeds/rewritable.html` in Chromium. Manually verify:
1. Double-click a paragraph → editable. Type `/make this a question` → tint + ✦
   appears; Enter → block is rewritten by the agent (with a real backend/bridge
   configured), `/command` text never persists.
2. Type `/usr/bin` → prompt mode; press Esc → tint clears, text stays literal,
   keep typing → commits as normal content on blur.
3. ⌘Z after a `/command` → one undo step reverts to the pre-command block.
4. A frozen block still won't enter edit.

Capture a note of results in the PR / diary. If anything diverges from the tests,
the tests were wrong — fix them, not just the behavior (Rule 9).

---

## Done criteria

- `tests/inline-edit.mjs`: original 40 + C1–C5 pass.
- `tests/view.mjs`: 19 pass (inline-edit inert under active view).
- `tests/lens.mjs` + `benchmark` conformance: unchanged/green.
- References regenerate clean.
- Real-browser pass (Task 8) confirms paint + the agent round-trip.
- Specs/docs updated; seed change mirrored where required.

## Explicitly NOT done here (later increments)

Single-click-to-edit (changes the documented anchor gesture); selection-substring
scope; doc-scope from the inline surface; the lens visually relocating to the
selection; voice input. Each is its own design+plan pass.

---

## Deferred follow-ups (from reviews)

- **`serializeLeafText`** — a text-mode sibling of `serializeLeafSafe` that skips the
  escape→unescape round trip structurally. Today `runInlineCommand` serializes the
  editable to escaped HTML and then inverts it entity-by-entity; a direct text
  serializer would remove the inversion entirely.
- **`resolveAnchorFind`-null as terminal in `runAnchoredCommand`** — the lens
  currently treats a null anchor resolution as agent-retryable; arguably it should
  be terminal (retrying cannot materialize the anchor). Pre-existing lens behavior,
  its own decision — not this increment's.
- **The `<br>`-first unescape ordering rule** in `runInlineCommand` (real soft breaks
  become newlines before entities unescape, so a typed literal `<br>` — which arrives
  escaped — is not mistaken for a soft break) is documented but not independently
  kill-testable by the current C3c fixture.
