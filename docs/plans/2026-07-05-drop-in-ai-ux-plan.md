# Drop-in AI UX Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make "drop your AI" the primary model-selection UX: a status-bar AI chip + panel, a drop-invitation card replacing the no-key settings auto-open, one unified "Use this AI" dialog (install + activate + model + connect in a single consent), plus an online AI Gallery (`/ai`) and client-side AI Maker (`/ai/maker`).

**Design:** `docs/plans/2026-07-05-drop-in-ai-ux-design.md` (validated). Read it first.

**Architecture:** UX layer over built machinery — no wire-format, crypto, or invariant changes. Increment 1 rewires seed UI surfaces around the existing `runtime.agents.*` / recommendation / drop-bridge functions. Increments 2–3 add service routes following the read-once-at-startup asset pattern; the maker signs client-side with WebCrypto Ed25519 and fills a server-templated carrier. Increment 4 syncs docs + regenerates references.

**Tech stack:** vanilla JS in the single-file seed (`seeds/rewritable.html`), zero-dep Node `http` service, jsdom + fake-indexeddb tests (`node tests/<name>.mjs`), `node --test` for service/cli tests.

**Working directory:** `.worktrees/drop-in-ai-ux` (branch `feature/drop-in-ai-ux`). All paths below are relative to that root.

**Ground rules (repo-specific):**
- The seed is one 580 KB file; **line numbers below were verified 2026-07-05** but shift as you edit — re-locate by the quoted anchor text, not the number.
- Commit with explicit paths only: `git commit -m "…" -- <paths>` (shared-tree discipline).
- Every seed change ends with `node tools/regenerate-refs.mjs` before the increment's final commit (Increment 4 does it once for all).
- Run a test file as `node tests/<file>.mjs` from the worktree root. It prints `N pass, 0 fail`.
- Style: match the seed's existing idioms — `typeof fn === 'function' &&` guards, `_skEsc()` for HTML escaping in runtime chrome, inline `style.cssText` for modals, `--gray-*` palette, no template literals containing `` ` `` inside INLINE_DOC-reachable strings.
- **Never commit a `.key.json`.** Task 2.1 adds a `.gitignore` guard before any key exists.

**Key existing functions you will reuse (all in `seeds/rewritable.html`):**

| Function | At (2026-07-05) | Does |
|---|---|---|
| `buildUI()` | :1498 | injects status bar + panels HTML |
| `syncBackendRows()` / `BACKEND_META` | :1681 / :1632 | settings rows per backend + hint HTML |
| `renderActionsModePanel(panel)` | :2325 region | Activity panel (Intelligences section lives here today) |
| `runtimeListAgents()` / `runtimeAgentActive()` | :7849 / :7852 | installed roles / active role |
| `runtimeSetActiveAgent(role)` | :7859 | activate (throws `unverified_agent`) |
| `runtimeInstallAgent(envelope)` | :7882 | gate + verify + persist to frozen zone |
| `showAgentInstallDialog(envelope)` | :8030 | the consent dialog (you will unify it) |
| `routeInstallFromText(text)` | :8116 | classify + route drop/picker text |
| `getRecommendation(envelope)` / `applyRecommendation(rec)` | :8165 / :8190 | envelope model/backend hint → sessionStorage |
| `offerRecommendedModel(role)` / `runtimeActivateAgent(role)` | :8200 / :8228 | the second dialog you will fold in |
| `affinityWarning(role)` | :8181 | advisory mismatch string |
| `modify()` no-key guard | :8951 `if (cfg.requiresKey && !cfg.apiKey)` | the auto-open-settings path you will replace |
| `resolveBackendConfig()` | :5666 | `{kind, requiresKey, apiKey, …}` for the session |

Session keys: `RWA.K_API='rwa_apikey'`, `RWA.K_MODEL='rwa_model'`, `RWA.K_BACKEND='rwa_backend'` (seed :437).

---

## Increment 1 — Seed UX (chip, panel, unified dialog, invitation)

### Task 1.1: Unified "Use this AI" dialog — failing tests first

**Files:**
- Modify: `tests/intelligence-drop.mjs` (extend; current 15 pass)
- Test fixture: reuses `examples/intelligence-carrier/concise-editor.html` (has `recommended_model`/`recommended_backend` on the envelope)

**Step 1: Read the existing test file end to end** (~350 lines). Note the `boot(body)` helper, the `check(msg, cond)` pattern, and how block D drives `window.__rwaHandleCarrierDrop` with a fake event `{dataTransfer:{files:[fileLike]}}` then clicks `[data-act=install]` inside `#rwa-agent-install`.

**Step 2: Append a new test block F — unified dialog.** After the existing blocks, add assertions that today FAIL:

```js
// F — unified "Use this AI" dialog: one confirm = install + activate + model + key (design 2026-07-05)
{
  const w = await boot(article);
  await w.__rwaInstallFromText(carrierHtml);          // opens the dialog
  await new Promise(r => setTimeout(r, 50));
  const dlg = w.document.getElementById('rwa-agent-install');
  check('F1 dialog present', !!dlg);
  check('F2 dialog title says Use this AI', /Use this AI/i.test(dlg.textContent));
  check('F3 model zone shows the recommendation', /concise/i.test(dlg.textContent) && dlg.textContent.includes('openrouter'));
  const keyInput = dlg.querySelector('[data-ai-key]');
  check('F4 connect zone: key field present (openrouter recommended, no session key)', !!keyInput);
  const useBtn = dlg.querySelector('[data-act=use]');
  check('F5 primary button disabled until key entered', useBtn && useBtn.disabled);
  keyInput.value = 'sk-or-test-123'; keyInput.dispatchEvent(new w.Event('input'));
  check('F6 button enables once key present', useBtn && !useBtn.disabled);
  useBtn.click();
  await new Promise(r => setTimeout(r, 200));
  const roles = w.runtime.agents.list();
  check('F7 installed', roles.some(a => a.role === 'concise-editor' && a.verified));
  check('F8 activated', (w.runtime.agents.active() || {}).role === 'concise-editor');
  check('F9 model applied', w.sessionStorage.getItem('rwa_model') === /* carrier's recommended_model — read it from the envelope in the test */ w.__rwaExtractAgentCarrier(carrierHtml)[0].recommended_model);
  check('F10 backend applied', w.sessionStorage.getItem('rwa_backend') === 'openrouter');
  check('F11 key stored (session only)', w.sessionStorage.getItem('rwa_apikey') === 'sk-or-test-123');
  check('F12 no second model-offer dialog', !w.document.getElementById('rwa-model-offer'));
}
// F13 — cancel is inert
{
  const w = await boot(article);
  await w.__rwaInstallFromText(carrierHtml);
  await new Promise(r => setTimeout(r, 50));
  w.document.querySelector('#rwa-agent-install [data-act=cancel]').click();
  await new Promise(r => setTimeout(r, 50));
  check('F13 cancel installs nothing', w.runtime.agents.list().length === 0 && !w.sessionStorage.getItem('rwa_apikey'));
}
```

Adapt selectors/waits to the file's existing rhythm. Also update any EXISTING blocks that click `[data-act=install]` — the button becomes `[data-act=use]` with new copy; those assertions must be revised **in this same task** so the suite's intent stays coherent (blocks A–C, extraction/classification, are untouched).

**Step 3: Run to verify the new block fails, old blocks pass**

Run: `node tests/intelligence-drop.mjs`
Expected: F1 may pass (dialog exists), F2–F12 FAIL (no unified dialog yet).

**Step 4: Commit the red tests**

```bash
git add tests/intelligence-drop.mjs
git commit -m "test(intelligence): red — unified Use-this-AI dialog (install+activate+model+connect)" -- tests/intelligence-drop.mjs
```

### Task 1.2: Implement the unified dialog

**Files:**
- Modify: `seeds/rewritable.html` — `showAgentInstallDialog` (:8030) + `routeInstallFromText` (:8116) + `offerRecommendedModel` callers

**Step 1: Rework `showAgentInstallDialog(envelope)` into the unified card.** Keep the function name (it's exported as `runtime.agents.showInstallDialog` :9768 — API name unchanged). Structure:

- **Identity zone**: keep the existing HTML verbatim (title becomes `Use this AI — “<role>”?`), including author/verify/gates logic, vault list, prompt preview, the "can vs should" caveat. Add the affinity line: `affinityWarning` can't be used pre-install (it reads `installedAgents`), so inline the same logic from `getAffinity(envelope)` vs `PRODUCT_KIND`.
- **Model zone**: `const rec = getRecommendation(envelope)`. If `rec` and it differs from current session (`RWA.K_MODEL`/`K_BACKEND` — same comparison `offerRecommendedModel` does :8204-8206): render *"Wants to use `<model>` via `<backend>`"* plus two radios `data-ai-modelchoice=rec|keep` (rec checked) when a current working setup exists; plain text when there's nothing current. If no `rec`: *"Uses your current model/backend."*
- **Connect zone** (recomputed whenever the radio changes): let `chosenBackend` = rec/keep choice. If `chosenBackend === 'openrouter'` and `!sessionStorage.getItem(RWA.K_API)` → password input `data-ai-key` + the session-only line *"Your key stays in this browser session — never in the file."* If chosen is `ollama`/`lmstudio`/`atomic` → inject `BACKEND_META[b].hintHTML` (it's in `buildUI`'s closure — **hoist `BACKEND_META` + `OPENROUTER_MODEL_SUGGESTIONS` out of `buildUI` to module scope**, a pure move, so the dialog can read it). No probe/Test button inside the dialog v1 — hint only (the ⚙ Test button remains the probe surface). Bridge backends → hint only.
- **Buttons**: `data-act=cancel` (unchanged) + `data-act=use` labeled **"Use this AI"**, rendered only when `canInstall` (same `gates.ok && verified` condition — unverified stays button-less). `disabled` while the connect zone requires a key and the field is empty; an `input` listener toggles it.
- **On use**: `const res = await runtimeInstallAgent(envelope); if (res.ok) { runtimeSetActiveAgent(agent.role); if (radio chose rec) applyRecommendation(rec); if (keyField has value) sessionStorage.setItem(RWA.K_API, keyField.value.trim()); }` then close with `res`. Also sync the ⚙ inputs like `applyRecommendation` does (it already updates `#rwa-model`/`#rwa-backend`; mirror for `#rwa-key`).
- Guard every DOM-settings sync in `try {} catch (_) {}` (existing pattern :8195).

**Step 2: Fold the second dialog out of the drop path.** `routeInstallFromText` already calls only `showAgentInstallDialog` — nothing to change there. In `runtimeActivateAgent` (:8228) keep `offerRecommendedModel` (the Activity-panel/API activation path still needs it until Task 1.6 reworks the panel); the unified dialog must NOT trigger it (it doesn't — it calls `runtimeSetActiveAgent` directly).

**Step 3: Run the tests**

Run: `node tests/intelligence-drop.mjs`
Expected: all pass (15 old ± revised + F block).

Run: `node tests/intelligence-model-rec.mjs && node tests/intelligence-affinity.mjs && node tests/intelligence-blend.mjs`
Expected: still green — `getRecommendation`/`applyRecommendation`/`offerRecommendedModel`/`runtimeActivateAgent` behavior is unchanged.

**Step 4: Commit**

```bash
git add seeds/rewritable.html tests/intelligence-drop.mjs
git commit -m "feat(seed): unified Use-this-AI dialog — install+activate+model+connect in one consent" -- seeds/rewritable.html tests/intelligence-drop.mjs
```

### Task 1.3: AI chip + AI panel — failing tests first

**Files:**
- Create: `tests/ai-chip.mjs` (model it on `tests/mode.mjs` boot pattern — plain seed, not skill-host, via `applySeedSubs` without kind overrides; plus one skill-host boot reusing the carrier install to get an installed role)

**Step 1: Write the test file.** Blocks:

```
A1  chip exists in the status bar (#rwa-st-ai inside #rwa-set), initial text matches /AI/ and has class 'none' (no active AI)
A2  chip click opens #rwa-ai-panel (classList 'open'), second click closes
A3  panel empty state: /Drop an AI file/ and a gallery link href containing '/ai', and a 'set up manually' control that opens #rwa-set-panel
B1  after installing + activating the carrier role via runtime.agents.install + setActive:
    chip text contains 'concise-editor', class 'none' removed
B2  panel shows the active card: role name, description, 'Deactivate' button, and 'using <model> via <backend>' OR 'not connected'
B3  Deactivate click → chip back to no-AI state
B4  with a second installed-but-inactive role: panel lists it with an Activate button; clicking it activates (runtime.agents.active().role flips)
C1  Activity panel (renderActionsModePanel) no longer contains an 'Intelligences' section
```

Reuse the install flow from `tests/intelligence-drop.mjs` (call `w.runtime.agents.install(envelope)` directly with an envelope extracted via `w.__rwaExtractAgentCarrier(carrierHtml)` — no dialog needed for setup). For B2's model line, set `w.sessionStorage.setItem('rwa_model','m1')` first.

**Step 2: Run to verify it fails**

Run: `node tests/ai-chip.mjs`
Expected: FAIL from A1 (no `#rwa-st-ai`).

**Step 3: Commit red**

```bash
git add tests/ai-chip.mjs
git commit -m "test(seed): red — AI chip + panel states" -- tests/ai-chip.mjs
```

### Task 1.4: Implement chip + panel

**Files:**
- Modify: `seeds/rewritable.html` — `buildUI()` HTML (:1499), status CSS (:44-57), panel wiring (near the `#rwa-st-cog` handler), new `renderAiChip()` + `renderAiPanel()`, small hooks in `runtimeSetActiveAgent`/`runtimeInstallAgent`/`runtimeUninstallAgent`

**Step 1: HTML.** In the `buildUI` template: add the chip button between the mode segment and the `⋯` button (:1505-1506):

```html
<button class="rwa-st-btn" id="rwa-st-ai" title="AI — drop one in, or manage" aria-haspopup="true">◇ AI</button>
```

and a `<div id="rwa-ai-panel"></div>` next to `#rwa-share-panel` (:1529).

**Step 2: CSS.** Beside `.rwa-st-btn` rules (:44-47): `#rwa-st-ai.none{color:var(--gray-400);}` and `#rwa-ai-panel` reuses the settings-panel look — copy the `#rwa-set-panel` fixed-position rule block (:56-57) as a grouped selector or a parallel rule (`top:50px;right:12px;width:340px`, same open/closed classes).

**Step 3: `renderAiChip()`** (define near `buildUI`): reads `runtimeAgentActive()` (guard `typeof runtimeAgentActive === 'function'` — chip renders before the agents block loads state); sets chip text `'◆ ' + role` / `'◇ AI'`, toggles class `none`; appends `' !'` + `title` when `affinityWarning(role)` returns non-null.

**Step 4: `renderAiPanel()`** (place beside `renderActionsModePanel` so the row/kicker CSS classes are shared): move the ENTIRE Intelligences block (list building :2327-2346 + handlers :2378-2392) into it, relabeled:

- kicker `AI`; active role renders as a card-style row on top: role, description (`manifest.description` — extend `runtimeListAgents()` to also return `description: a.manifest && a.manifest.description`), and a status line: if `resolveBackendConfig()` has what it needs (`!requiresKey || apiKey`) → `'using ' + (sessionStorage model || RWA.MODEL) + ' via ' + backend`; else `'not connected'` + a **Connect** button (v1: opens `#rwa-set-panel` — the slim connect card is Task 1.5's invite, don't duplicate it here).
- Buttons keep their `data-agent-on/off/advon/advoff` contracts (handlers move verbatim; after each action call `renderAiChip(); renderAiPanel(panel)`).
- Meta line copy: `'AI · verified · …'` instead of `'intelligence · …'`; advisor button copy `Add as advisor AI`.
- Footer: `'Drop an AI file anywhere on this page — or browse the <a href="https://rewritable.ikangai.com/ai" target="_blank" rel="noopener">AI Gallery</a>'` + a `set up manually (⚙)` button that closes this panel and opens `#rwa-set-panel`.
- Empty state (no roles): the footer alone.

**Step 5: Wire open/close.** Copy the `#rwa-st-cog` handler pattern (:1785-1791): chip click closes sibling panels (`rwa-set-panel`, `rwa-info-panel`, `rwa-skin-panel`, `rwa-share-panel`, menu) and toggles `rwa-ai-panel` + `renderAiPanel(...)` on open. Add `rwa-ai-panel` to the cog handler's (and other panels') close-siblings list.

**Step 6: Remove the Intelligences section from `renderActionsModePanel`** (:2325-2346 list, :2361 section line, :2378-2392 handlers) — the panel's Activity/Recent runs/affordances/skills sections stay.

**Step 7: Refresh hooks.** At the end of `runtimeSetActiveAgent`, `runtimeInstallAgent` (success path), `runtimeUninstallAgent` (success path): `try { typeof renderAiChip === 'function' && renderAiChip(); } catch (_) {}`. Call `renderAiChip()` once at the end of boot (after `readTrustworthyAgents` has populated `installedAgents` — find the boot sequence that calls it and append after).

**Step 8: Run**

Run: `node tests/ai-chip.mjs && node tests/intelligence-drop.mjs && node tests/mode.mjs && node tests/view.mjs`
Expected: all green (mode/view guard against status-bar regressions).

**Step 9: Commit**

```bash
git add seeds/rewritable.html tests/ai-chip.mjs
git commit -m "feat(seed): AI chip + AI panel — the document's AI becomes visible, Activity sheds Intelligences" -- seeds/rewritable.html tests/ai-chip.mjs
```

### Task 1.5: Drop invitation replaces the no-key auto-open

**Files:**
- Modify: `tests/ai-chip.mjs` (new block D), then `seeds/rewritable.html` — the `modify()` guard (:8951-8957) + new `showAiInvite()`

**Step 1: Red tests (block D in `tests/ai-chip.mjs`).** Find how an existing test drives `modify()` with no key (check `tests/backends.mjs` / `tests/lens.mjs` for the entry — `window.runtime.modify` or the lens hook; use the same). Assert:

```
D1  no-key ⌘K: #rwa-set-panel does NOT get class 'open'; #rwa-ai-invite appears
D2  invite copy: /no AI connected/i, /Drop an AI file/i, gallery href contains '/ai'
D3  invite 'set up manually' → closes invite, opens #rwa-set-panel (the escape hatch)
D4  AI-aware variant: install+activate carrier role, clear rwa_apikey → invite says the role name + /connect a model/i and shows a key field; entering a key + confirm stores rwa_apikey and closes
D5  with a working session (key set), modify() proceeds past the guard (reaches the mutex/'⌘K running' path — assert the invite does NOT appear)
```

Run: `node tests/ai-chip.mjs` → D block FAILS. Commit red:

```bash
git add tests/ai-chip.mjs
git commit -m "test(seed): red — drop invitation replaces no-key settings auto-open" -- tests/ai-chip.mjs
```

**Step 2: Implement `showAiInvite()`** (place beside `showAgentInstallDialog`, reusing its overlay/card cssText, id `rwa-ai-invite`):

- Variant pick: `const act = runtimeAgentActive();` If an active (or single installed verified) role exists → AI-aware: `“<role>” is ready — connect a model to run it` + the connect zone (reuse the same key-field markup as the unified dialog; extract a tiny helper `_aiConnectZoneHtml(backend)` used by both) + confirm button storing the key. Else generic: title `This document has no AI connected`, body `Drop an AI file anywhere on this page — it installs behind a consent card.` + gallery link + `set up manually` button (`#rwa-set-panel` open + focus `#rwa-key`, i.e. exactly the old guard behavior) + Close.
- Replace the guard body (:8952-8956): keep both `setPalSt`/`setLensProgress` error lines but change the message to `'no AI connected — drop one in'`, then `showAiInvite(); return;`.
- Leave the `throw` sites (:5438, :5748) untouched — they are programmatic paths (skin compose, CLI-ish), not the interactive lens.

**Step 3: Run**

Run: `node tests/ai-chip.mjs && node tests/intelligence-drop.mjs && node tests/skin-compose.mjs`
Expected: green (skin-compose confirms :5438 untouched).

**Step 4: Commit**

```bash
git add seeds/rewritable.html tests/ai-chip.mjs
git commit -m "feat(seed): drop-invitation card — no-key ⌘K invites an AI drop instead of opening settings" -- seeds/rewritable.html tests/ai-chip.mjs
```

### Task 1.6: Panel-activate path joins the one-code-path rule + copy sweep

**Files:**
- Modify: `seeds/rewritable.html`, `tests/intelligence-model-rec.mjs`

**Step 1:** `runtimeActivateAgent` keeps `setActive + offerRecommendedModel` (it's the public `runtime.agents.activate` API — external callers still get the offer). But the AI-panel Activate button now follows with the connect check: after `runtimeActivateAgent(role)` resolves, if the session can't run (`requiresKey && !apiKey`) call `showAiInvite()` (which renders the AI-aware connect variant). Add that to the `data-agent-on` handler in `renderAiPanel`.

**Step 2: Copy sweep** (user-facing strings only): `offerRecommendedModel` card — `Use this intelligence's recommended…` → `Use this AI's recommended…`; grep the seed for `intelligence` in UI strings (`setStatus` messages, `runtimePromptInstall` accept text, drop-size error :8139, `no installable skill or intelligence` :8121 → `…skill or AI`) and retitle. Do NOT rename functions, comments, test hooks, or spec references.

**Step 3:** Update `tests/intelligence-model-rec.mjs` assertions that match the old copy. Run:

Run: `for t in ai-chip intelligence-drop intelligence-model-rec intelligence-affinity intelligence-blend mode backends view; do node tests/$t.mjs || break; done`
Expected: all green.

**Step 4: Commit**

```bash
git add seeds/rewritable.html tests/intelligence-model-rec.mjs
git commit -m "feat(seed): AI copy sweep + panel-activate connect check" -- seeds/rewritable.html tests/intelligence-model-rec.mjs
```

### Task 1.7: Increment-1 gate — full seed suite + browser proof

**Step 1:** Run the whole tests/ suite: `for f in tests/*.mjs; do echo "== $f"; node "$f" || break; done`. Every file green (fix regressions before continuing; `tests/skill-*` and `tests/vault*` are the likely collateral if you touched shared chrome).

**Step 2: Browser proof (real Chrome, not jsdom):** regenerate refs (`node tools/regenerate-refs.mjs`), open `hello.html` from disk, and walk: chip visible ◇ → drag `examples/intelligence-carrier/concise-editor.html` onto the page → unified dialog shows identity+model+key field → enter a dummy key → Use this AI → chip shows ◆ concise-editor → ⌘K opens lens (backend will fail on a dummy key — that's fine, the UX path is what's being proven) → chip panel Deactivate → chip back to ◇ → ⌘K with no key shows the invitation, its ⚙ escape hatch opens settings. Record a short GIF if convenient. **Report what you actually saw — if any step misbehaves, stop and fix.**

**Step 3: Checkpoint commit** (regenerated refs):

```bash
git add hello.html re-write-able-spec.html examples/intelligence-carrier/concise-editor.html
git commit -m "chore(refs): regenerate references after drop-in-AI seed UX" -- hello.html re-write-able-spec.html examples/intelligence-carrier/concise-editor.html
```

---

## Increment 2 — AI Gallery (`/ai`)

### Task 2.1: Key hygiene guard (before any carrier is minted)

**Step 1:** Append to the repo `.gitignore`: `*.key.json`. Verify `git check-ignore -q foo.key.json` → ignored.

**Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore *.key.json — intelligence private keys never enter the repo" -- .gitignore
```

### Task 2.2: Mint the curated carriers

**Files:**
- Create: `service/public/ai/carriers/{proofreader,translator,presentation-coach,playful-rewriter}.intelligence.html` + copy `concise-editor`
- Create: `service/public/ai/README.md`

**Step 1:** Mint with the CLI (from the worktree root; keys land in a NON-repo dir):

```bash
mkdir -p service/public/ai/carriers ~/rwa-gallery-keys
node cli/bin/rwa.mjs intelligence new proofreader \
  --prompt "You are a meticulous proofreader. Fix spelling, grammar, and punctuation only. Never rephrase, never restructure, never change meaning or tone. If a sentence is correct, leave it byte-identical." \
  --description "Fixes errors. Never rewrites." \
  --model google/gemini-3.5-flash --backend openrouter \
  --out service/public/ai/carriers/proofreader.intelligence.html
mv service/public/ai/carriers/proofreader.intelligence.key.json ~/rwa-gallery-keys/
```

Repeat for: `translator` (DE↔EN tone-preserving; same model), `presentation-coach` (`--affinity presentation`, prompt about slide economy/one-idea-per-slide), `playful-rewriter` (personality-forward prompt). Copy the existing example as the fifth: `cp examples/intelligence-carrier/concise-editor.html service/public/ai/carriers/concise-editor.intelligence.html`. Verify each: `node cli/bin/rwa.mjs doc service/public/ai/carriers/<name>.intelligence.html --json | head -c 400` shows `skill-host`.

**Step 2:** `service/public/ai/README.md`: list the five roles + author fingerprints (from the CLI output), state the key-custody rule (keys live outside the repo with the author), and the regen rule (these carriers embed the seed → add them to `tools/regenerate-refs.mjs` REFS in Task 4.2; re-mint/re-sign only when the RECORD changes).

**Step 3:** Tell the user where the four new `.key.json` files are (`~/rwa-gallery-keys/`) in your checkpoint report — they are his author identities now.

**Step 4: Commit**

```bash
git add service/public/ai/carriers service/public/ai/README.md
git commit -m "feat(service): five curated gallery carriers (signed; keys held offline by author)" -- service/public/ai/carriers service/public/ai/README.md
```

### Task 2.3: Routes — red tests

**Files:**
- Create: `service/tests/ai-gallery.test.mjs` (model on `service/tests/share.test.mjs` — it shows how these tests boot the server; follow it)

**Step 1:** Tests (`node --test service/tests/ai-gallery.test.mjs`):

```
GET /ai            → 200 text/html, body contains 'Drop-in AI' and each carrier name and href="/ai/maker"
GET /ai/proofreader.intelligence.html → 200, Content-Disposition attachment, body contains 'rwa-agent+json'
GET /ai/nope.intelligence.html        → 404
GET /ai/../server.js                  → 404 (allowlist, no traversal)
GET /               → landing body contains href="/ai" and 'Examples' (renamed nav), not '>Gallery<' pointing at demos
```

Run → FAIL (routes missing). Commit red:

```bash
git add service/tests/ai-gallery.test.mjs
git commit -m "test(service): red — /ai gallery routes" -- service/tests/ai-gallery.test.mjs
```

### Task 2.4: Implement gallery page + routes + landing rename

**Files:**
- Create: `service/public/ai/index.html`
- Modify: `service/server.js` (startup reads + route branches beside `/import` :1514), `service/public/landing.html` (:381, :485, :594)

**Step 1: `service/public/ai/index.html`** — static page in the landing's visual language (open `landing.html`, reuse its `<style>` conventions: same palette vars, nav, footer). Content per design §4: hero *"Drop-in AIs. Download one, drag it onto any rewritable."*, 3-step strip, five cards (name / one-liner / model+backend badge / affinity badge / short fingerprint / Download button `href="/ai/<name>.intelligence.html"`), closing CTA to `/ai/maker`. Card metadata is hand-written into the HTML (5 curated entries — no build step; keep it honest with the carriers).

**Step 2: `server.js`.** At startup (beside `IMPORT_HTML` :27): read `AI_INDEX_HTML` and an `AI_CARRIERS` Map — `fs.readdirSync(<public/ai/carriers>)` filtered to `/^[a-z0-9_-]+\.intelligence\.html$/`, each read into memory. Routes (beside `/import` :1514-1518): `/ai` → 200 `AI_INDEX_HTML` (`max-age=300`); `if (url.startsWith('/ai/'))` → exact-match the Map key (the filename after `/ai/`), 200 with `Content-Type: text/html`, `Content-Disposition: attachment; filename="<name>"`, `max-age=300`; miss → fall through to 404. No path parsing beyond the Map lookup — the allowlist IS the Map.

**Step 3: `landing.html`.** Replace the two nav/footer `>Gallery<` labels (:381, :594) with `Examples` (same `/demo/html-effectiveness/` href) and add `<a href="/ai">AI Gallery</a>` beside each; the demo card (:485) keeps its href, retitle its visible 'Gallery' text if present.

**Step 4:** Run: `node --test service/tests/ai-gallery.test.mjs` → green. Also `node --test service/tests/` → all green (no regressions).

**Step 5: Commit**

```bash
git add service/server.js service/public/ai/index.html service/public/landing.html
git commit -m "feat(service): /ai gallery — curated drop-in AIs, landing nav rename Gallery→Examples" -- service/server.js service/public/ai/index.html service/public/landing.html
```

---

## Increment 3 — AI Maker (`/ai/maker`)

### Task 3.1: Template route — red tests

**Files:**
- Modify: `service/tests/ai-gallery.test.mjs` (add a maker section, or a sibling `ai-maker.test.mjs`)

**Step 1:** Tests:

```
GET /ai/template.html → 200 no-store; body is a rewritable (contains 'rwa-bootstrap' and PRODUCT_KIND skill-host);
                        contains the two placeholder markers RWA_MAKER_CARD and RWA_MAKER_ZONE inside INLINE_DOC;
                        contains the role placeholder RWA_MAKER_ROLE in <title>;
                        two requests → different DOC_UUIDs (fresh per request)
GET /ai/maker         → 200 text/html, body contains 'AI Maker' and NO cdn scripts (self-contained page)
```

Run → FAIL. Commit red:

```bash
git add service/tests/ai-gallery.test.mjs
git commit -m "test(service): red — maker page + carrier template route" -- service/tests/ai-gallery.test.mjs
```

### Task 3.2: Implement `/ai/template.html`

**Files:**
- Modify: `service/server.js`

**Step 1:** The service already vendors `service/lib/seed.mjs` (byte-mirror of `cli/src/seed.mjs` — check it exports `applySeedSubs`, `kindOverrides`, `replaceInlineDoc`; it's cmp-gated so do NOT edit it). Find how `server.js` builds `/rewritable.html` (:1586-1595) — mirror that: at request time, take the startup-read seed, then

```js
const ov = kindOverrides('skill-host');
let t = applySeedSubs(seedHtml, { uuid: randomUUID(), title: 'Intelligence — RWA_MAKER_ROLE', fileMeta: 'RWA_MAKER_ROLE.intelligence.html', productKind: 'skill-host', lensPlaceholder: ov.lensPlaceholder, palPlaceholder: ov.palPlaceholder, productHeader: ov.productHeader, lensClickToAnchor: ov.lensClickToAnchor });
t = replaceInlineDoc(t, '<!--RWA_MAKER_CARD-->\n<!--RWA_MAKER_ZONE-->');
```

Serve `no-store`. (Role names are validated `[a-z0-9_-]` client-side, so a global `RWA_MAKER_ROLE` replace on the client is collision-safe.)

**Step 2:** Run the template tests → green. Commit:

```bash
git add service/server.js
git commit -m "feat(service): /ai/template.html — fresh skill-host carrier template for the maker" -- service/server.js
```

### Task 3.3: Maker page + signing parity test

**Files:**
- Create: `service/public/ai/maker.html`
- Create: `service/tests/maker-parity.test.mjs`
- Modify: `service/server.js` (`/ai/maker` route reading `maker.html` at startup)

**Step 1: Parity test first (red).** `maker-parity.test.mjs`: extract the canon block from `maker.html` between markers `// rwa:maker-canon:begin` / `// rwa:maker-canon:end`, evaluate it in `node:vm`, and against `service/lib/skill-manifest.mjs` (`canonicalAgent`, `agentSigningMessage`) assert on a fixture agent: (a) canonical bytes identical, (b) a signature minted with the maker's `sign()` verifies with the lib's verify path and vice-versa (Ed25519 via `node:crypto.webcrypto`). Fails: no maker.html yet.

**Step 2: `maker.html`.** Self-contained (no CDN — WebCrypto only), landing visual language. Structure:

- Form: role name (pattern `[a-z0-9][a-z0-9_-]{0,63}`, live-validated), description, personality textarea (reject `` ` ``/`${`/`</?DOC>` — same guard as CLI :25), recommended model (`<datalist>` = the curated OpenRouter list from the seed) + backend `<select>` (6 names), affinity checkboxes (`document presentation workflow skill-host datatable` — copy the kind list from `cli/bin/rwa.mjs`), an `<details>Advanced</details>` fold for vault namespaces. Live card preview (`buildCard` port).
- Canon block between `// rwa:maker-canon:begin/end`: port `canonicalAgent` + `agentSigningMessage` **verbatim** from `cli/src/skill-manifest.mjs` (:237, :250), plus b64 helpers.
- On **Create my AI**: `crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify'])` → build `agent` exactly as `cli/src/intelligence.mjs` :35 (same field order) → sign → envelope with unsigned `recommended_model`/`recommended_backend`/`affinity` → `fetch('/ai/template.html')` → replace `RWA_MAKER_ROLE` (global), `<!--RWA_MAKER_CARD-->` with the `buildCard(...)` port, `<!--RWA_MAKER_ZONE-->` with `'<div data-rwa-frozen id="rwa-agents"><scr'+'ipt type="application/rwa-agent+json">' + b64 + '</scr'+'ipt></div>'` — **but escape for INLINE_DOC**: the zone goes INTO the template's INLINE_DOC region which the server already escaped… no: the server put literal markers inside INLINE_DOC post-escaping, so the client must apply `escapeForTL` semantics to what it injects (escape `` \ ` ${ </script ``  — port the 4-rule `escapeTL` from `cli/src/seed.mjs`, add it to the canon block + parity test).
- Downloads: two `Blob` + `a[download]` — `<role>.intelligence.html`, `<role>.intelligence.key.json` (same JSON shape + SECRET warning as CLI :56-60). Post-create panel: fingerprint, "keep the key file" warning, "test it: open the carrier — it installs its own role", link back to `/ai`.
- If `crypto.subtle.generateKey` throws (no Ed25519 — old browser): show a clear message naming a current Chrome/Safari/Firefox, don't half-work.

**Step 3:** `/ai/maker` route in `server.js` (startup read + 200, `max-age=300`).

**Step 4:** Run: `node --test service/tests/` → green, incl. parity + maker routes.

**Step 5: Manual proof:** `PORT=3000 node service/server.js`, open `/ai/maker` in Chrome, create a test AI, verify the downloaded carrier: (a) opens standalone and its AI panel lists the role verified, (b) drops onto a fresh `hello.html` and the unified dialog verifies the signature (✓ not tampered). Report what you saw.

**Step 6: Commit**

```bash
git add service/public/ai/maker.html service/server.js service/tests/maker-parity.test.mjs service/tests/ai-gallery.test.mjs
git commit -m "feat(service): /ai/maker — client-side signed drop-in AI authoring (keys never leave the browser)" -- service/public/ai/maker.html service/server.js service/tests/maker-parity.test.mjs service/tests/ai-gallery.test.mjs
```

---

## Increment 4 — Docs, spec, refs

### Task 4.1: intelligence spec §7 (bump to 0.3)

**Files:**
- Modify: `docs/specs/rwa-intelligence-spec.md`

Add a short **§7 Presentation layer (intelligence/0.3)** — pointers, not restatement: names the four surfaces (chip+panel, invitation, unified consent, gallery+maker), states the consent semantics didn't move (one card shows everything the two dialogs showed; unverified still un-installable; key still sessionStorage-only, now enterable inside the consent card), notes the maker as a second authoring surface sharing the CLI's canon (parity-pinned). Update the header/close lines `0.2` → `0.3` and the trailing summary. Commit:

```bash
git add docs/specs/rwa-intelligence-spec.md
git commit -m "docs(spec): intelligence/0.3 — §7 presentation layer (drop-in AI surfaces)" -- docs/specs/rwa-intelligence-spec.md
```

### Task 4.2: Gallery carriers join the regen discipline

**Files:**
- Modify: `tools/regenerate-refs.mjs` (REFS array :16-25)

Add the four new gallery carriers (kind `skill-host`, like the concise-editor entry :25) so a future seed change regenerates them with records preserved. Run `node tools/regenerate-refs.mjs`; confirm `git diff --stat` touches only expected files; run `node tests/intelligence-drop.mjs` once more (carrier bytes moved). Commit regenerated files + tool:

```bash
git add tools/regenerate-refs.mjs service/public/ai/carriers hello.html re-write-able-spec.html examples/intelligence-carrier/concise-editor.html
git commit -m "chore(refs): gallery carriers join regenerate-refs" -- tools/regenerate-refs.mjs service/public/ai/carriers hello.html re-write-able-spec.html examples/intelligence-carrier/concise-editor.html
```

### Task 4.3: CLAUDE.md routing

**Files:**
- Modify: `CLAUDE.md`

In the **Intelligence** routing entry: add the presentation layer (chip/panel/invite/unified dialog seed blocks + `tests/ai-chip.mjs`; `service/public/ai/` gallery+maker; the maker-canon mirror of `cli/src/skill-manifest.mjs` pinned by `service/tests/maker-parity.test.mjs`; spec now `intelligence/0.3`). One entry, dense, matching the file's style. Also note the moved Intelligences section under the runtime-modes entry if it mentions the Activity panel's sections. Commit:

```bash
git add CLAUDE.md
git commit -m "docs: routing — drop-in AI presentation layer (chip, gallery, maker, parity mirror)" -- CLAUDE.md
```

### Task 4.4: Final gate

1. Full seed suite: `for f in tests/*.mjs; do node "$f" || break; done` — all green.
2. `node --test service/tests/` and `node --test cli/tests/` — all green.
3. `cd benchmark && npm run conformance` — no regressions vs main.
4. Browser walk (Task 1.7 script) once more on the regenerated `hello.html` + the served `/ai` + `/ai/maker`.
5. Checkpoint summary to the user: what shipped, what was verified where (jsdom vs browser vs manual), the `~/rwa-gallery-keys/` custody note, and the deploy reminder (service assets are read at startup → prod needs rebuild/redeploy; seed changed → `/rewritable.html` payload changes).

Then use superpowers:finishing-a-development-branch (merge/PR decision belongs to Martin — the repo pushes straight to main by convention, but this branch touches the seed heavily; propose a merge to main after review).

**Explicit non-goals** (do not build, even if tempting): hosted proxy backend, gallery submissions, `intelligence/1` wire fork, I-B config portability, in-dialog reachability probes for local backends (hint-only in v1), persona/memory features (future alley — recorded in the design doc only).
