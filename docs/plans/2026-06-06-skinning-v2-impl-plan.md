# Skinning v2 — L1 Content-Aware Restyle (compose-then-commit) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Single-writer on `seeds/rewritable.html` — coordinate seed ownership with shannon/dirac via `.groupchat` before each seed-editing session; commit with **explicit paths** (never `-a`/`-A`).

**Goal:** When a user applies a skin (gallery click or `/skin NAME`), the runtime drives the agent to add `sk-*` content-aware restyle wrappers AND swaps in the deterministic theme block, landing both as **one commit** (one `rwa_undo` frame → one ⌘Z reverts the whole skin), attributed `actor:'skin:NAME'`.

**Architecture (Path A — replace_document combined commit):** Add a `noCommit` option to `applyEdits` so the agent's validated, shape-checked restyle string can be obtained without committing. Add a `compose` option to `modify()` that runs the existing multi-turn tool-use loop in no-commit mode, then deterministically splices the theme `<style data-rwa-skin>` block onto the agent's output and commits the composed doc **once** via `replaceDocument`. The agent contributes additive markup only (`computeShape` blocks any `<style>`/`<script>` injection); the runtime alone adds the known theme block. New `applySkinL1(name)` drives this; the ✦ gallery + `/skin` lens call it. Bridge/single-shot backends fall back to L0 theme-only with a loud notice.

**Tech Stack:** Vanilla JS inside `seeds/rewritable.html` (no build). jsdom + fake-indexeddb tests in `tests/` (model: `tests/region-commit.mjs`). Conformance scenarios in `benchmark/scenarios/conformance/` (agent stubbed at the fetch layer). CLI mirror in `cli/src/skins.mjs` (byte-pinned by `tests/skins-seed-mirror.test.mjs`).

---

## Locked decisions (from the author, 2026-06-06)

- **Commit path:** Path A — `replace_document` combined commit. No seed-baked placeholder. Universal (new + existing docs), minimal seed surface. Hist kind = `replace_document` (functionally one commit / one ⌘Z, which is the actual requirement).
- **Preset scope:** All **5 shipped** presets get L1 (notion-clean, linear-dark, editorial-serif, stripe-docs, terminal-mono).
- **CLI:** stays theme-only (L0) in v2. The `sk-*` CSS rules ride in each preset's `theme` (mirrored, harmless when no wrappers exist); the recipe instruction strings are **seed-only** (`RWA_SKIN_RECIPES`, NOT mirrored). CLI L1 is a follow-up increment.
- **Single-undo is a hard requirement** (the whole point of compose-then-commit). Never split a skin across two commits.

## Invariants the implementation MUST hold (from the maps)

- **One commit = one `rwa_undo` frame + one `rwa_hist` record** (`commitDoc` `:3530`). Compose mode calls `commitDoc` exactly once (via the final `replaceDocument`).
- **Frozen wall holds for the agent:** `applyEdits` never receives `frozenBypass`; the compose path must NOT introduce one. The skin `<style>` carries `data-rwa-skin` ONLY (never `data-rwa-frozen`).
- **`computeShape` stays the agent's structural guard:** the agent's `apply_edits` (no-commit) still runs `computeShape` — so the agent cannot add/remove `<style>`/`<script>`. Only the runtime's deterministic theme splice adds the one `<style>`, validated by the shape-exempt `replaceDocument`.
- **L1 is additive-only / 1:1-invertible:** recipes WRAP contiguous runs and ADD `sk-*` classes only — never delete, move, merge, re-tag, or renumber `data-rwa-id`. (No re-tagging → de-skin stays a clean strip.)
- **`sk-` hook prefix** for all L1 classes/wrappers (maximally distinct from reserved `rwa-*`/`data-rwa-*`). `data-rwa-skin` is writable (NOT in `RESERVED_MARKERS`); do not widen the reserved-substring guard to a `data-rwa-` prefix.
- **`#rwa-doc-mount` scoping** for all skin CSS (tokens + element rules + `sk-*` rules) — never `:root` (would re-tint frozen runtime chrome).
- **Byte-mirror** `cli/src/skins.mjs` (canonical) ↔ seed `RWA_SKINS` (`tests/skins-seed-mirror.test.mjs` serializes `name/label/swatch/theme`). Adding `sk-*` CSS to `theme` keeps the mirror valid; do not add new mirrored fields.
- **`dispose()` drain** in `benchmark/runners/harness.mjs:144-149` (SNAPSHOT-01 fix) must not regress — new skin scenarios dispose in `finally`.
- **`modify()` non-compose path stays byte-identical** — every compose change is guarded by `opts?.compose`.

## File map (all seed line numbers are pre-edit, from the 2026-06-06 maps — re-confirm before editing)

- `seeds/rewritable.html`
  - `applyEdits` `:3573-3653` — add `opts` param + `noCommit` early-return.
  - `modify` `:4747-4888` — add `opts` param + compose branch (decline-break, no-commit dispatch, post-loop transform+commit).
  - skin block `~:2547-2779` — add `RWA_SKIN_RECIPES`, `spliceSkinBlock`, `applySkinL1`; update `RWA_SKINS` `theme` strings (re-embed); wire gallery swatch + `/skin` lens to `applySkinL1`.
- `cli/src/skins.mjs` — add `sk-*` CSS rules to the 5 `theme` strings (canonical source for the byte-mirror).
- `tests/skin-compose.mjs` (NEW) — jsdom pin for the primitive (model: `tests/region-commit.mjs`).
- `benchmark/scenarios/conformance/skin-03.mjs` (NEW) — L1 apply + one-commit + one-⌘Z, agent stubbed.
- `docs/specs/` + `CLAUDE.md` — document `noCommit`/`compose`/`applySkinL1`; update skinning routing.
- `docs/plans/2026-06-03-skinning-design.md` — mark v2 status.

---

## Task 1: `noCommit` option on `applyEdits`

**Files:**
- Modify: `seeds/rewritable.html:3573` (signature) and `:3644-3652` (early return)
- Test: `tests/skin-compose.mjs` (NEW)

**Step 1: Write the failing test** (model on `tests/region-commit.mjs` — copy `boot`/`readStore`/`check`/`tick`). Boot a document whose body has a unique anchor, then:

```js
// applyEdits with {noCommit:true} returns the spliced string and does NOT commit.
const before = await readStore(uuid, 'rwa_hist');             // undefined or array
const beforeLen = Array.isArray(before) ? before.length : 0;
const out = await window.applyEdits(
  { version: 'rwa-edit/1', edits: [{ find: 'ANCHOR', replace: 'ANCHOR-X' }] },
  await window.getDoc(), null, { noCommit: true });
check('noCommit returns spliced string', typeof out === 'string' && out.includes('ANCHOR-X'));
await tick();
const after = await readStore(uuid, 'rwa_hist');
const afterLen = Array.isArray(after) ? after.length : 0;
check('noCommit did NOT write rwa_hist', afterLen === beforeLen);
// Control: default (no opts) still commits.
await window.applyEdits({ version: 'rwa-edit/1', edits: [{ find: 'ANCHOR-X', replace: 'ANCHOR-Y' }] }, out, null);
await tick();
const after2 = await readStore(uuid, 'rwa_hist');
check('default still commits', Array.isArray(after2) && after2.length === beforeLen + 1);
```

**Step 2: Run to verify it fails** — `(cd tests && node skin-compose.mjs)`. Expected: FAIL on "noCommit returns spliced string" (4th arg ignored today → it commits and returns persistDoc, which equals `out` but the hist length grows).

**Step 3: Minimal implementation.** Change the signature and add the early return:

```js
async function applyEdits(envelope, currentDocRaw, lensMeta = null, opts = null) {
```
Insert immediately before `const histRecord = ...` at `:3645`:
```js
  // compose-then-commit (skinning-v2): return the validated, shape-checked
  // string WITHOUT committing, so the caller can splice a deterministic
  // theme block and commit the composed doc once. Default path unchanged.
  if (opts && opts.noCommit) return work;
```

**Step 4: Run to verify it passes** — `(cd tests && node skin-compose.mjs)`. Expected: PASS for all three checks.

**Step 5: Commit**
```bash
git add seeds/rewritable.html tests/skin-compose.mjs
git commit -m "feat(seed): applyEdits noCommit option — accumulate-without-commit seam for skinning-v2

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `compose` option on `modify()`

**Files:**
- Modify: `seeds/rewritable.html:4747` (signature), `:4811-4817` (decline branch), `:4839-4846` (dispatch), `:4856-4858` (post-loop)
- Test: `tests/skin-compose.mjs` (extend)

**Design.** `modify(instr, lensMeta = null, opts = null)`. When `opts.compose` is set (`{ transform(agentDoc, baseDoc) -> finalDocString, reason }`):
- Decline branch: instead of early `return`, set `lastFailure` and `break` (so the post-loop still runs → theme-only fallback).
- Dispatch: pass `{ noCommit: true }` to `applyEdits` (4th arg). For `replace_document` in compose mode, the agent already produced a whole doc — treat `envelope.doc` (after a one-shot `replaceDocument` validation) as `agentDoc`; simplest robust choice: in compose mode, restrict the accepted tool to `apply_edits`/`apply_dsl_plan→apply_edits`; if the model emits `replace_document`, feed back a failure tool_result steering it to `apply_edits` (the recipe also says "use apply_edits"). This keeps the agent contribution additive + shape-guarded.
- Post-loop (before `if (newDoc !== null)`): 
```js
    if (opts && opts.compose) {
      const base = (newDoc !== null) ? newDoc : cur;   // graceful: theme-only if agent gave nothing
      const finalDoc = opts.compose.transform(base, cur);
      newDoc = await replaceDocument(
        { version: 'rwa-edit/1', doc: finalDoc, reason: opts.compose.reason },
        cur, lensMeta);                                  // the ONE commit (one undo frame)
    }
```
The existing `if (newDoc !== null) { renderDoc(newDoc); ... }` then runs unchanged.

**Step 1: Write the failing test.** Extend `tests/skin-compose.mjs`. Stub the agent via the runtime's fetch (the test boots with `fetch` throwing — override `window.fetch` to a canned OpenAI response returning an `apply_edits` tool call that adds `class="sk-test"` to a unique anchor). Then:
```js
window.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '',
  tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edits',
    arguments: JSON.stringify({ version: 'rwa-edit/1', edits: [{ find: '<p>ANCHOR</p>', replace: '<div class="sk-test"><p>ANCHOR</p></div>' }] }) } }] } }] }) });
const histBefore = (await readStore(uuid, 'rwa_hist'))?.length || 0;
const undoBefore = (await readStore(uuid, 'rwa_undo'))?.length || 0;
await window.modify('TEST RECIPE', { surface: 'skin:l1', actor: 'skin:notion-clean' }, {
  compose: { transform: (agentDoc) => '<style data-rwa-skin="notion-clean">/*t*/</style>\n' + agentDoc, reason: 'skin:notion-clean (theme+L1)' } });
await tick(); await tick();
const doc = await window.getDoc();
check('agent L1 wrapper present', /class="sk-test"/.test(doc));
check('deterministic theme block present', /<style data-rwa-skin="notion-clean">/.test(doc));
const histAfter = (await readStore(uuid, 'rwa_hist'))?.length || 0;
const undoAfter = (await readStore(uuid, 'rwa_undo'))?.length || 0;
check('exactly ONE rwa_hist entry added', histAfter - histBefore === 1);
check('exactly ONE rwa_undo frame added', undoAfter - undoBefore === 1);
check('actor attributed skin:NAME', (await readStore(uuid, 'rwa_hist'))[0].actor === 'skin:notion-clean');
check('hist kind replace_document', (await readStore(uuid, 'rwa_hist'))[0].kind === 'replace_document');
```
Add a second case: **graceful degradation** — fetch returns a message with NO `tool_calls` (model declines); assert the theme block still landed and `histAfter - histBefore === 1` (theme-only, one commit).

**Step 2: Run to verify it fails** — Expected: FAIL (compose option ignored; today `modify` has arity 2 and the agent's apply_edits would either commit separately or the wrapper+theme wouldn't both land in one commit).

**Step 3: Implement** the four edits above.

**Step 4: Run to verify it passes.** Then run the regression guard for the non-compose path: `(cd benchmark && npm run conformance)` — expect the same total as on `main` (currently 84/84), and the jsdom suite green. This proves `modify()`'s normal ⌘K path is byte-behavior-identical.

**Step 5: Commit**
```bash
git add seeds/rewritable.html tests/skin-compose.mjs
git commit -m "feat(seed): modify() compose option — run agent no-commit, splice theme, ONE commit (skinning-v2 gate)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `spliceSkinBlock` + `applySkinL1` + RWA_SKIN_RECIPES

**Files:**
- Modify: `seeds/rewritable.html` skin block (`~:2693` for the helper, `~:2714` after `resetSkin` for `applySkinL1`, `~:2555` add `RWA_SKIN_RECIPES`)
- Test: `tests/skin-compose.mjs` (extend)

**Step 1: Write `spliceSkinBlock`** (beside the block regexes `~:2693`), shared swap/prepend logic:
```js
function spliceSkinBlock(doc, theme) {
  return RWA_SKIN_BLOCK_RE.test(doc) ? doc.replace(RWA_SKIN_BLOCK_RE, theme) : theme + '\n' + doc;
}
```

**Step 2: Add `RWA_SKIN_RECIPES`** (seed-only, NOT mirrored — place AFTER `RWA_SKINS` so it is not captured by the mirror test's `RWA_SKINS = {...}` slice). Each value is the per-preset agent instruction. Every recipe begins with the shared de-skin preamble + additive constraints, then the preset-specific moves (from the design notes, normalized to `sk-` + wrap/add-class only, no re-tag):

```js
const RWA_SKIN_L1_PREAMBLE =
  'Apply a visual restyle by adding sk-* class hooks and additive wrapper elements. STRICT RULES: ' +
  'only ADD wrapper <div>/<span> elements and ADD class attributes; never delete, move, merge, reorder, ' +
  're-tag, or rewrite existing content; never change any data-rwa-id; never add <style> or <script>; ' +
  'never touch frozen zones. If the document already contains sk-* wrappers or sk-* classes from a previous ' +
  'skin, first remove those wrappers (keeping their inner content) and strip the sk-* classes, then apply ' +
  'the restyle below. Use apply_edits with surgical (find,replace) pairs.\n\nRestyle:\n';

const RWA_SKIN_RECIPES = {
  'notion-clean': RWA_SKIN_L1_PREAMBLE +
    '1. If a short subtitle/dek paragraph sits directly under the H1, add class="sk-eyebrow" to it. ' +
    '2. Convert any paragraph that begins "Note:", "Tip:", or "Important:" into <div class="sk-callout">…</div> (wrap the paragraph). ' +
    '3. Leave lists and tables unchanged.',
  'linear-dark': RWA_SKIN_L1_PREAMBLE +
    '1. If a short kicker/category line opens the document (above or right after the H1), wrap it as <div class="sk-eyebrow">…</div>. ' +
    '2. If you find a contiguous run of 2–4 short metric lines (e.g. "MRR $48k", "Churn 1.2%"), wrap each as <div class="sk-stat"><b>$48k</b><span>MRR</span></div> and group them in one <div class="sk-stat-row">…</div>. ' +
    '3. Leave all other structure unchanged.',
  'editorial-serif': RWA_SKIN_L1_PREAMBLE +
    '1. A category/section word before the title → wrap as <div class="sk-kicker">…</div> above the H1. ' +
    '2. A byline/dateline under the H1 ("By …", a date, "5 min read") → add class="sk-byline". ' +
    '3. Wrap the first body paragraph (the lede) as <div class="sk-lede">…</div>. ' +
    '4. A standalone single-sentence emphatic paragraph → wrap as <div class="sk-pull">…</div> (do NOT re-tag to blockquote).',
  'stripe-docs': RWA_SKIN_L1_PREAMBLE +
    '1. Wrap the leading H1 and its dek paragraph together in <div class="sk-hero">…</div>. ' +
    '2. A one-word kicker/category before the H1 → wrap as <span class="sk-pill">…</span> at the top of the hero. ' +
    '3. Leave code blocks, lists, and tables unchanged.',
  'terminal-mono': RWA_SKIN_L1_PREAMBLE +
    '1. Wrap the leading H1 (and a following byline/subtitle paragraph) in <div class="sk-hero">…</div>; add class="sk-byline" to that paragraph. ' +
    '2. A contiguous run of metric lines (number + short label, e.g. "42 commits") → wrap in <div class="sk-stat-row"> with each as <div class="sk-stat"><span class="sk-stat-num">42</span><span class="sk-stat-label">commits</span></div>. ' +
    '3. Append <span class="sk-blink">▋</span> after the final paragraph.',
};
```

**Step 3: Add `applySkinL1`** (after `resetSkin`, `~:2714`):
```js
async function applySkinL1(name) {
  const skin = RWA_SKINS[name];
  if (!skin) throw new RwaEditError('unknown_skin', null, { name, known: Object.keys(RWA_SKINS) });
  const recipe = RWA_SKIN_RECIPES[name];
  const cfg = resolveBackendConfig();
  // L1 needs a multi-turn tool-use backend; bridge/single-shot → theme-only (L0) + loud notice.
  if (!recipe || cfg.kind === 'bridge' || cfg.kind === 'bridge-session') {
    if (cfg.kind === 'bridge' || cfg.kind === 'bridge-session')
      showAffordance('skin: theme-only (L1 restyle needs openrouter/ollama/lmstudio)');
    return applySkin(name);
  }
  await modify(recipe, { surface: 'skin:l1', actor: 'skin:' + name }, {
    compose: { transform: (agentDoc) => spliceSkinBlock(agentDoc, skin.theme), reason: 'skin:' + name + ' (theme+L1)' },
  });
}
window.applySkinL1 = applySkinL1;
```

**Step 4: Test.** Extend `tests/skin-compose.mjs`: stub the agent (apply_edits adding a `sk-eyebrow` wrapper to a doc with a kicker line), call `await window.applySkinL1('linear-dark')`, assert: theme block for linear-dark present, `sk-eyebrow` present, Δhist===1, Δundo===1, actor `skin:linear-dark`. Add a bridge-fallback case: set `sessionStorage rwa_backend='bridge'` (or whatever `resolveBackendConfig` reads) and assert `applySkinL1` lands theme-only via the L0 path (no fetch needed) — verify the theme block present and no `sk-*` wrapper added.

**Step 5: Run + Commit**
```bash
git add seeds/rewritable.html tests/skin-compose.mjs
git commit -m "feat(seed): applySkinL1 + RWA_SKIN_RECIPES — always-on L1 restyle for the 5 presets (one commit, theme+wrappers)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `sk-*` CSS rules in the 5 preset theme blocks (CLI canonical → seed mirror)

**Files:**
- Modify: `cli/src/skins.mjs` (the 5 `theme` strings — canonical)
- Modify: `seeds/rewritable.html:2555-2692` (`RWA_SKINS` embed — regenerate to match)
- Test: `tests/skins-seed-mirror.test.mjs` (no code change — it re-derives the embed; must still pass)

**Step 1:** For each preset, append `#rwa-doc-mount`-scoped CSS rules for the `sk-*` classes its recipe produces (so the wrappers are actually styled). Keep self-contained (system fonts, no `@import`/`url(http…)`/`@font-face`), no `!important` (must not fight the print stylesheet). Example for `linear-dark`:
```css
#rwa-doc-mount .sk-eyebrow{font:600 12px/1 var(--font-mono,monospace);letter-spacing:.12em;text-transform:uppercase;color:#7c6cff;margin:0 0 8px}
#rwa-doc-mount .sk-stat-row{display:flex;flex-wrap:wrap;gap:16px;margin:24px 0}
#rwa-doc-mount .sk-stat{display:flex;flex-direction:column;gap:2px;padding:12px 16px;border:1px solid #23263a;border-radius:10px;background:#0d0f17}
#rwa-doc-mount .sk-stat b{font-size:22px;color:#e9eaee}
#rwa-doc-mount .sk-stat span{font:500 11px/1 var(--font-mono,monospace);text-transform:uppercase;letter-spacing:.08em;color:#8b8fa3}
```
Author the matching rule sets for `notion-clean` (`.sk-eyebrow`, `.sk-callout`), `editorial-serif` (`.sk-kicker`, `.sk-byline`, `.sk-lede` drop-cap via `::first-letter`, `.sk-pull`), `stripe-docs` (`.sk-hero`, `.sk-pill`), `terminal-mono` (`.sk-hero`, `.sk-byline`, `.sk-stat-row`, `.sk-stat`, `.sk-stat-num`, `.sk-stat-label`, `.sk-blink` with a `@media (prefers-reduced-motion: reduce)` guard disabling the blink).

**Step 2:** Regenerate the seed `RWA_SKINS` embed from the updated `cli/src/skins.mjs`. Use the same serialization the mirror test uses (`escTL` over `name/label/swatch/theme`). Reuse the test's `canonicalEmbed` logic or a one-off node script that imports `SKINS` and prints the `const RWA_SKINS = {…};` block, then paste it verbatim over `:2555-2692`. **Do not hand-edit the seed embed.**

**Step 3: Run the mirror test** — `node tests/skins-seed-mirror.test.mjs` (or its npm entry). Expected: PASS (seed embed byte-matches the regenerated block).

**Step 4:** Run the CLI suite — `(cd cli && npm test)` — expect green (skin.mjs/skins.mjs theme strings changed but the CLI behavior is unchanged; the dead `sk-*` CSS is harmless when no wrappers exist).

**Step 5: Commit**
```bash
git add cli/src/skins.mjs seeds/rewritable.html
git commit -m "feat(skins): sk-* CSS rules for the 5 presets (theme blocks, #rwa-doc-mount-scoped) — styles the v2 L1 wrappers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Wire the ✦ gallery + `/skin` lens to `applySkinL1`

**Files:**
- Modify: `seeds/rewritable.html:2745` (gallery swatch onclick) and `:2778` (`/skin NAME` lens handler)

**Step 1:** Gallery swatch click (`:2745`) — change `applySkin(b.getAttribute('data-skin'))` → `applySkinL1(b.getAttribute('data-skin'))`. `/skin NAME` (`:2778`) — change `await applySkin(arg)` → `await applySkinL1(arg)`. Leave `resetSkin` (gallery reset + `/skin reset`) and bare `/skin` (gallery open) unchanged. Keep `applySkin` exported (CLI parity / the L1 fallback uses it).

**Step 2: Test** — extend SKIN-02-style coverage (see Task 6) or add a jsdom assertion that the swatch onclick path reaches `applySkinL1` (stub the agent, click the swatch, poll for both the theme block AND an `sk-*` wrapper).

**Step 3: Run + Commit**
```bash
git add seeds/rewritable.html
git commit -m "feat(seed): ✦ gallery + /skin lens drive applySkinL1 (always-on L1 restyle)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: SKIN-03 conformance scenario (L1 apply + one-commit + one-⌘Z)

**Files:**
- Create: `benchmark/scenarios/conformance/skin-03.mjs`

**Step 1:** Author the scenario (model: `skin-01.mjs` for helpers, `mutex-01.mjs:38-60` for the agent fetch stub). Use a body with a kicker line + a metric run so `linear-dark`'s recipe has something to wrap. `default export { id:'SKIN-03', category:'SKIN', weight:1, description, async run({ harness }) }`:
```js
const ctx = await harness.fresh();
try {
  ctx.setFetchHandler(async () => ({ ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'apply_edits', arguments: JSON.stringify({ version: 'rwa-edit/1',
      edits: [{ find: '<p>Q1 update</p>', replace: '<div class="sk-eyebrow"><p>Q1 update</p></div>' }] }) } }] } }] }) }));
  const histBefore = (await ctx.getHistory()).length;
  const undoBefore = (await ctx.getUndoStack()).length;
  await ctx.window.applySkinL1('linear-dark');
  await tick(); await tick();
  const doc = await ctx.getDoc();
  const ok = /<style data-rwa-skin="linear-dark">/.test(doc)
    && /class="sk-eyebrow"/.test(doc)
    && (doc.match(/data-rwa-skin=/g) || []).length === 1
    && (await ctx.getHistory()).length - histBefore === 1
    && (await ctx.getUndoStack()).length - undoBefore === 1
    && (await ctx.getHistory())[0].actor === 'skin:linear-dark';
  // one-⌘Z revert: both theme block AND sk-eyebrow gone after undo
  await ctx.window.runtime.undo(); await tick();
  const reverted = await ctx.getDoc();
  const undoneClean = !/data-rwa-skin/.test(reverted) && !/sk-eyebrow/.test(reverted);
  return { pass: ok && undoneClean, reason: ok ? (undoneClean ? '' : 'undo did not revert both') : 'apply assertions failed' };
} finally { ctx.dispose(); }
```
(Confirm `ctx.window` / the undo entrypoint name against `harness.mjs` and `skin-02.mjs` when implementing.)

**Step 2: Run just this scenario** (the runner has no filter — direct import), from inside `benchmark/`:
```bash
node -e 'import("./scenarios/conformance/skin-03.mjs").then(async m=>{const h=await import("./runners/harness.mjs");const r=await m.default.run({harness:h});console.log(JSON.stringify(r));process.exit(r.pass?0:1)})'
```
Expected: `{"pass":true,...}`.

**Step 3: Run the full conformance suite** — `(cd benchmark && npm run conformance)`. Expected: 85/85 (84 prior + SKIN-03), exit 0, stable across repeated runs (watch for any SNAPSHOT-01-style teardown flake — SKIN-03 disposes in `finally`).

**Step 4: Commit**
```bash
git add benchmark/scenarios/conformance/skin-03.mjs
git commit -m "test(conformance): SKIN-03 — v2 L1 apply lands theme+sk-* in ONE commit, one ⌘Z reverts both

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Spec + CLAUDE.md + references

**Files:**
- Modify: `docs/specs/rwa-edit-spec.md` (document the `noCommit` option as runtime-internal, NOT an agent-facing tool) and/or `docs/specs/rwa-runtime-region-commit-spec.md` neighborhood (compose-then-commit is the agent-edit composition sibling of region-commit).
- Modify: `CLAUDE.md` — under skinning routing: note `applySkinL1`/`RWA_SKIN_RECIPES`/`spliceSkinBlock` + the `modify()` compose option + `applyEdits` `noCommit`; state CLI stays theme-only (recipes seed-only, `sk-*` CSS mirrored in `theme`).
- Modify: `docs/plans/2026-06-03-skinning-design.md` — STATUS: v2 L1 BUILT (Path A, 5 presets); note deferred (full deterministic de-skin, CLI L1, v3 vision/12-preset library).
- Run: `node tools/regenerate-refs.mjs` (regenerate `hello.html`/`re-write-able-spec.html` from the seed since `RWA_SKINS` theme strings changed).

**Step 1–N:** Make the doc edits; regenerate refs; verify refs differ only in the expected `RWA_SKINS`/skin regions (`git diff --stat`). 

**Commit**
```bash
git add CLAUDE.md docs/specs/ docs/plans/2026-06-03-skinning-design.md hello.html re-write-able-spec.html
git commit -m "docs(skinning): document v2 L1 compose-then-commit (noCommit/compose/applySkinL1); regen refs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Adversarial review (workflow)

After all tasks green, run a multi-agent adversarial review (security / spec-conformance / edge-cases / 4-site-mirror) of the v2 skinning diff — the same discipline shannon used on the skill layer (which caught 2 criticals). Targets: can the agent reach a `frozenBypass`? can the compose path commit twice? does a malformed/declined agent response ever leave a half-skinned doc or zero-commit? does `replace_document`'s class-lock-coverage reject legitimate skins? does the `sk-*` CSS leak to `:root` / use `!important` / smuggle a URL? Fix confirmed findings, card the rest.

---

## Verification checklist (Rule 4 success criteria)

- [ ] `tests/skin-compose.mjs` green (noCommit, compose one-commit, graceful degradation, applySkinL1, bridge fallback).
- [ ] `tests/skins-seed-mirror.test.mjs` green (seed `RWA_SKINS` byte-matches `cli/src/skins.mjs`).
- [ ] `benchmark` conformance 85/85, stable, exit 0 (incl. SKIN-03; SNAPSHOT-01 not regressed).
- [ ] Full jsdom `tests/` suite + `tests/region-commit.mjs` green (modify() non-compose path unchanged).
- [ ] `(cd cli && npm test)` green.
- [ ] One ⌘Z reverts a skin (theme + sk-* wrappers) atomically — proven in SKIN-03.
- [ ] Browser smoke (optional but recommended): real Chromium, apply a skin via the gallery against a live backend, confirm theme + wrappers + single undo.
- [ ] Adversarial review: 0 unresolved criticals/highs.
