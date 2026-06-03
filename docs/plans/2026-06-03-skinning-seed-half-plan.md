# Skinning — the seed half (runtime gallery + lens + activeSkin): implementation plan

**Status:** plan, pre-implementation. Coordinates with dirac (seed owner) + shannon (skill-layer, overlapping files). Builds on the shipped v1 CLI half (`rwa skin` / `rwa new --skin`, 5 presets, merged at `8e07b70`). Branch: `feat/skinning-v1` (worktree `.worktrees/skinning-v1`, updated to main `e37bf29`).

Line numbers below are from `seeds/rewritable.html` as of `e37bf29` (shannon's increments 1‑4 did **not** touch the seed file, so they're current).

## Two forks the recon surfaced — resolved

1. **Skin lives in the document, not in chrome.** A recon path suggested `<html data-rwa-skin>` + sessionStorage. **Rejected** — that wouldn't survive export. The skin is a `<style data-rwa-skin>` block **inside `INLINE_DOC`**, applied by a deterministic commit, exactly like the v1 CLI. It ships in the file, commits, and ⌘Z reverts it. (Locked design.)
2. **The deterministic `commitCore` path *does* enforce the structural-shape (`<style>`-count) guard** (it runs inside `applyEdits`, seed `:3238`). So the runtime `applySkin` mirrors the CLI's `skinCmd` exactly: block present → `apply_edits` swap (count stable); **no** block → `replace_document` insert (shape-exempt); reset → remove. This **decouples the gallery/lens from the seed-baked placeholder** — the runtime handles insert-or-swap itself, so the placeholder becomes an optional optimization (deferred, see Phase 3).

## Architecture (mirrors the CLI, in the runtime)

`applySkin(name)` / `resetSkin()` are **model-free**:
1. `const doc = await getDoc()` (seed `:839`).
2. Locate the leading `<style data-rwa-skin="…">…</style>` (regex, same as `cli/src/skin.mjs`).
3. Build envelope: block present → `{version:'rwa-edit/1', edits:[{find:oldBlock, replace:newBlock}]}`; absent → `{version:'rwa-edit/1', doc:<block + '\n' + doc>, reason:'skin:'+name}` (replace_document insert); reset → swap-to-empty / remove.
4. `await runtime.applyEnvelope(envelope, {surface:'skin:apply', actor:'skin:'+name})` → `synthesizeAndCommit` (`:2862`) → `commitCore` (`:2884`) → atomic `commitDoc` (`:3138`) with `actor` in the hist record → `renderDoc` re-renders. **No new commit machinery** — rides R5 (dirac's audited no-side-effect path).

The preset CSS is the **same bytes** as `cli/src/skins.mjs` — embedded in the runtime as a `SKINS` table, **test-pinned** to the CLI module (the canonical source), per the design's "one source, mirrored" rule.

## Build increments (TDD where the jsdom harness reaches; visual-verify the chrome)

### Phase 1 — runtime apply + lens (seed-only, DISJOINT from shannon) — *do first*
- **P1a. Embed the preset library** in the runtime: a `SKINS` constant (mirror of `cli/src/skins.mjs`). Pin with a test that the seed's embedded table deep-equals the CLI module (drift fails) — same discipline as `apply-edits.mjs`/`identity.mjs` mirrors.
- **P1b. `applySkin(name)` / `resetSkin()`** runtime functions (insert/swap/reset via `runtime.applyEnvelope`, `actor:'skin:NAME'`). Reuse `SKIN_BLOCK_RE` from the CLI.
- **P1c. `/skin` lens commands** in `submitLens` (`:2496`): insert a recognition block at the top of `if (isCommand)` (before the `anchored`/`modify()` split, `:2502`). `/skin NAME` → `applySkin`; `/skin reset` → `resetSkin`; bare `/skin` → open the gallery panel. `return` after the input-clear tail; `throw` a coded error on unknown name (keydown catch at `:1225` preserves input + shows it). Anchored `/skin …` → ignore the anchor (skin is document-global) or `showAffordance` a release hint.

### Phase 2 — gallery chrome (seed-only, DISJOINT) 
- **P2a. `✦` button** in the `#rwa-set` row: add `<button class="rwa-st-btn" id="rwa-skin-btn" title="skins">✦</button>` between `⚙` (`:1005`) and `⌘S` (`:1006`).
- **P2b. `#rwa-skin-panel`** sibling after `:1015`; CSS copies `#rwa-set-panel` (`:39-40`) verbatim with the new id. A `.rwa-skin-grid` of swatch buttons (pure CSS/inline-SVG thumbnails from each preset's `swatch`), `Reset` footer. Fill `innerHTML` on open (mirror the info-panel refill at `:1180`).
- **P2c. Handlers**: `#rwa-skin-btn.onclick` mirrors `#rwa-st-info` (`:1177`); add `#rwa-skin-panel` `.remove('open')` into the cog (`:1171`) + info (`:1178`) handlers so all three panels stay mutually exclusive. Swatch click → `applySkin(dataset.skin)`; reset → `resetSkin()`.
- **P2d. Lens hint** (`#rwa-lens-hint`, `:1035`, currently unused): on a blank/unskinned doc, set "pick a look with ✦ Skins".

### Phase 3 — placeholder + activeSkin (OVERLAPS shannon — sequence the merge)
- **P3a. Seed-baked placeholder** `<style data-rwa-skin=""></style>` as a leading body child: seed `INLINE_DOC` (`:288`, after the existing functional `<style>`, before `<article>`) + `cli/src/seed.mjs` kind bodies (`KIND_WORKFLOW_BODY` after `wf-style` frozen end `:182`; `KIND_PRESENTATION_BODY` before `<article>` `:1305`; `document` inherits the seed default; **skill-host** — shannon's new kind — needs one too). One-time `<style>`-count +1 that must land in the seed INLINE_DOC + `hello.html`/`re-write-able-spec.html` references + all CLI kind bodies **together**. *Overlaps shannon's `cli/src/seed.mjs` kindOverrides edits — sequence.*
- **P3b. `activeSkin` self-description** (top-level, **body-computable** so it appears in static AND live — unlike `activeView` which is live-only; per the skinning design doc, a static reader must be able to report the applied skin from the bytes):
  - seed `runtimeDescribe` (`:3692`): add `activeSkin: <read data-rwa-skin off #rwa-doc-mount, '' → null>`.
  - oracle `tools/self-description.mjs`: `extractActiveSkin(doc)` near `staticTitle` (`:76`); add to `computeSelfDescription` (static) + a `validateSelfDescription` clause (`:190`). *Overlaps shannon's recent edits here — rebase/sequence.*
  - mirror `cli/src/identity.mjs`: same, near `extractTitle` (`:54`) + `buildSelfDescription` + validator (`:204`). *Overlaps shannon.*
  - `cli/src/doc.mjs`: rides along via the projection; pin in `cli/tests/doc.test.mjs`.
  - spec `docs/specs/rwa-self-description-spec.md`: add the `activeSkin` row, an SD line, bump to v1.2.
  - **Empty value → `null`**: an empty placeholder `data-rwa-skin=""` reports `activeSkin: null`.

### Phase 4 — references + verify
- `node tools/regenerate-refs.mjs` to refresh `hello.html` + `re-write-able-spec.html` from the seed.
- Full suites: `cd cli && node --test 'tests/*.test.mjs'`; conformance (`cd benchmark && npm run conformance`). Visual: drive a skinned container in Chrome (hand off the chrome-devtools profile with shannon) to confirm the gallery + apply render.

## Sequencing with the team
- **dirac (seed owner):** Phases 1‑2 are seed-only and textually disjoint from the skill-layer runtime (`#rwa-skills`, install dialog). Need his go-ahead to edit the seed + a marker comment to keep regions disjoint from shannon's increments 5‑9.
- **shannon:** Phase 3 overlaps `cli/src/seed.mjs` (kindOverrides — her skill-host kind) and the self-description trio (her skill-union). Sequence: whoever lands first leaves a marker; the other rebases. `activeSkin` is a top-level field (NOT in the `affordances` array), so it never touches `parseSkillZone` — additive next to her union.
- The v2 **always-on L1 restyle** stays out of this plan — it's gated on dirac's standalone runtime-owned-region-commit primitive (skinning's region is edit-*reachable*, the reachability=edit-reachable case of that primitive).

## Risk / guardrails
- The runtime `applySkin` must NOT mark the skin block `data-rwa-frozen` (or the swap fails `frozen_zone_corrupted`, seed `:3245`). The block is intentionally edit-reachable.
- `data-rwa-skin` is **reserved as a namespace** (CLAUDE.md doc list) but **NOT** added to `RWA_EDIT.RESERVED` (`:1794`) — the model must keep writing it.
- Keep the embedded `SKINS` table byte-identical to `cli/src/skins.mjs` (test-pinned).
