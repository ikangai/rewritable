# Chrome IA — Edit toggle + ⋯ menu

Date: 2026-06-24
User decision: collapse the 4-tab mode chrome (Document/Edit/Skills/Actions) into an
**Edit toggle + a single ⋯ menu**. View (Document) is the quiet default; Edit is an
activation toggle that lights up the editing affordances; Skills/Activity move into the menu.

## Why

The 4 tabs conflate two axes. **View↔Edit** is the only real *mode of the document*.
**Skills** is a skill-host management surface (meaningless on a plain file). **Actions** is
a grab-bag whose buttons (Undo/Save/Share) duplicate existing affordances; its unique value
is the edit **history** + affordance inspector. So: one toggle + a menu, nothing else persistent.

## Target chrome

```
Reading:   ●  [ Edit ]      ⋯          (Save hidden — nothing to save)
Editing:   ●  [ Edit·on ]   ⌘S   ⋯     (+ the selection formatting bubble)
```
- **Edit toggle** (`#rwa-st-edit`): click flips `document`↔`edit` via `runtimeSetMode`.
  `.on` + `aria-pressed` reflect `rwaMode === 'edit'`. role="switch".
- **⌘S** (`#rwa-st-commit`): visible **only when dirty** (`setDirty` toggles `hidden`).
  ⌘S keyboard still works; the Activity panel keeps an explicit Save/Export.
- **⋯ menu** gains two items (reusing `data-rwa-mode-target` so the existing
  `attachModeTabs`/`syncModeChrome` wire + highlight them): **Activity** (`actions` mode,
  always) and **Skills** (`skills` mode, **shown only on skill-host** via `isRwaSkillHost()`).
  Existing items (What is this?, Settings, Skins, Share) stay.

## What does NOT change (load-bearing)

`RWA_MODES` (still `document/edit/skills/actions`), `runtimeSetMode`, `renderModePanel`,
the `'mode'` hook event, the `data-rwa-mode` CSS gating, the skill layer — all untouched.
Tests drive modes via `setMode()` (not the tab DOM), so removing the tab bar is safe. The
menu's Skills/Activity items just call `setMode('skills'/'actions')` → the existing panels.

## Changes

1. Markup: remove `#rwa-mode-tabs` (4 buttons) → add `#rwa-st-edit` toggle in `#rwa-set`.
   Add `#rwa-st-skills` (hidden) + `#rwa-st-activity` menu items (with `data-rwa-mode-target`).
2. `syncModeChrome`: also reflect the Edit toggle (`.on`/`aria-pressed` when edit). Keep the
   `[data-rwa-mode-target]` loop (now highlights the Skills/Activity menu items).
3. `buildUI`: wire `#rwa-st-edit` to toggle `document`↔`edit`; show `#rwa-st-skills` only when
   `isRwaSkillHost()`.
4. `setDirty`: hide `#rwa-st-commit` when clean, show when dirty (boot starts clean → hidden).
5. Rename the Actions panel "Action center" → "Activity" (content kept — Undo/Save/Share +
   Recent runs + Live affordances + skill actions). Update the `mode.mjs` assertion.

## Tests

- `tests/chrome.mjs`: Edit toggle present + toggles `data-rwa-mode`; tabs gone; Save hidden
  when clean / shown when dirty; menu has Activity always + Skills only on skill-host;
  clicking Activity opens the mode panel.
- `tests/mode.mjs`: "Action center" → "Activity" (one assertion); skills/actions setMode paths
  unchanged.
- Browser-verify (Chromium): reading view shows just `● [Edit] ⋯`; toggling Edit lights the
  bubble; Save appears after an edit; Skills hidden on a document, present on skill-host.

## Out of scope (note for later)

Trimming the Activity panel to a pure history view (dropping the redundant Undo/Save/Share);
the View/Edit segmented variant; per-kind tab filtering. This increment keeps the panel content
and only re-homes access.
