# Artifact drop bus — implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans / subagent-driven-development to implement task-by-task.

**Goal:** Unify the seed's two drop paths (AI/skill carrier install + image ingest) behind one classifier + dispatcher + shared consent shell; add skin as a first new droppable class (compose); add an advisory `accepts` declaration. Per `docs/plans/2026-07-06-artifact-bus-design.md`.

**Architecture:** A `classifyArtifact(input)` → `{class, semantics, payload, source}` that both existing drop listeners consult; a dispatcher routing by `semantics` to per-class handlers (existing `routeInstallFromText` = install; `insertImageFiles` = ingest; new skin handler = compose). A shared `showArtifactConsent(...)` shell extracted from `showAgentInstallDialog`. An `accepts` declaration read from the doc, enforced advisory-by-default / strict-on-opt-in.

**Tech stack:** vanilla JS in `seeds/rewritable.html`; jsdom+fake-indexeddb tests (`node tests/<name>.mjs`). Working dir: `.worktrees/artifact-bus` (branch `feature/artifact-bus`).

**Ground rules:** line numbers below verified 2026-07-06 but re-locate by anchor text. Commit explicit-paths only. Match seed idioms. **Behavior-preserving is the bar for Increment 1** — `tests/intelligence-drop.mjs` (38) + `tests/image-assets.mjs` (92) must stay green after the refactor. Regenerate refs once at the end.

**Verified anchors (seeds/rewritable.html):**
| Anchor | At | Role |
|---|---|---|
| `handleCarrierDrop` + `window…drop` capture | :8399 / :8416 | carrier drop (any mode, window-wide) |
| `handleMountDrop` + `m…drop` | :4635 / :1293 | image drop (edit-mode, mount-targeted) |
| `classifyInstallText` | :8367 | install sniff → json-agent/json-skill/agent-carrier/none |
| `routeInstallFromText` | :8382 | install dispatch → consent dialogs |
| `ingestImageFile` / `insertImageFiles` | :4484 / near :4646 | image ingest |
| `showAgentInstallDialog` | :8157 | the consent modal to extract the shell from |
| `runtimeProvide` / `runtimeDescribe` | :7021 / :8777 | self-description registry |
| declared `#rwa-affordances` read (`declarationFacts`/parse) | :7128 region | edit-unreachable declaration parse |
| `applySkinL1` / `RWA_SKIN_RECIPES` / `RWA_SKINS` / `spliceSkinBlock` | :5463 / :5422 / (mirror) / :4989 | skin compose path |
| test hooks `window.__rwaClassifyInstallText` / `__rwaInstallFromText` / `__ingestImageFile` | :8419 / :4526 | automation surface |

---

## Increment 1 — the classifier + dispatcher (behavior-preserving)

### Task 1.1 — `classifyArtifact` (red → green)
**Test (new `tests/artifact-bus.mjs`, block A):** `window.__rwaClassifyArtifact(file|text)` returns `{class, semantics, payload, source}`:
- an AI carrier `.html` / json-agent / json-skill → `{class:'install', semantics:'install', source:'declared', payload:<the install classification>}` (delegates to `classifyInstallText`).
- an image File (`file.type` `image/*`) → `{class:'ingest', semantics:'ingest', source:'sniffed', payload:{files:[file]}}`.
- unknown → `{class:null, semantics:null, source:null}` (today's `kind:'none'`).
Assert precedence: an `.html` that IS a carrier classifies install even though `.html` isn't an image.
**Impl:** add `classifyArtifact` beside `classifyInstallText`; it wraps the existing install sniff + adds the image sniff. Keep `classifyInstallText` unchanged (install-internal). Expose `window.__rwaClassifyArtifact`.
**Green:** `node tests/artifact-bus.mjs` block A; `tests/intelligence-drop.mjs` 38/0 (classifyInstallText untouched).
Commit red then green.

### Task 1.2 — the dispatcher (both listeners consult it; behavior-preserving)
**Test (block B):** a `dispatchArtifact(classified, ctx)` routes: install → `routeInstallFromText`-equivalent; ingest → `insertImageFiles`; unknown → the "not a recognized artifact" status. `ctx` carries mode/target for ingest.
**Impl:** introduce `dispatchArtifact(cls, ctx)`. Rewire the TWO existing handlers to `classifyArtifact` + `dispatchArtifact`, PRESERVING each class's context: install stays any-mode window-wide (capture-phase claim of a classified-install drop); ingest stays edit-mode + mount-target (the mount handler passes `{mode, target}` and dispatch enforces the edit-mode gate for ingest exactly as `handleMountDrop` does today). The capture-phase carrier-before-image priority becomes: the window handler claims a drop only if it classifies as a non-ingest class; ingest falls through to the mount handler (unchanged coordination, now explicit).
**Green:** `tests/artifact-bus.mjs` A+B; `tests/intelligence-drop.mjs` 38/0; `tests/image-assets.mjs` 92/0; `tests/mode.mjs` 18/0. This is the load-bearing behavior-preservation proof.
Commit.

### Task 1.3 — Increment-1 gate
Full drop-relevant sweep (intelligence-drop, image-assets, mode, view, ai-chip, lens) green. Checkpoint.

---

## Increment 2 — skin as the first new class (compose)

### Task 2.1 — the `rwa-artifact/1` skin artifact + classification (red → green)
**Define the minimal artifact tag:** a skin artifact is JSON (or a tiny `.html` carrier) `{format:'rwa-artifact/1', class:'compose', artifact:'skin', skin:{name}}` where `name ∈ RWA_SKINS` (v1: preset-name only; a `{theme}` variant is deferred).
**Test (block C):** `classifyArtifact` on a skin artifact → `{class:'compose', semantics:'compose', source:'declared', payload:{artifact:'skin', skin:{name}}}`; an unknown `artifact` or bad skin name → unknown/`none` (fail-loud, never a silent no-op).
**Impl:** extend `classifyArtifact`'s declared branch to parse the `rwa-artifact/1` tag before the carrier sniff.
Commit red then green.

### Task 2.2 — the compose handler (skin-drop end-to-end)
**Test (block D):** dispatching a compose/skin artifact calls the existing `applySkinL1(name)` compose-then-commit (ONE commit, actor `skin:NAME`). Reuse `tests/skin-compose.mjs` patterns for asserting the single commit. Invalid preset → fail-loud status, no commit.
**Impl:** a `dispatchArtifact` compose branch → `applySkinL1(payload.skin.name)`. Edit-mode gate consistent with other compose entry points (the `/skin` lens / gallery swatch). Actor stays `skin:NAME`.
**Green:** block D; `tests/skin-compose.mjs` 89/89 (existing skin path untouched); intelligence-drop + image-assets still green.
Commit. **If skin-drop fights the bus here, STOP and report — that's the design's cheap signal the model doesn't hold.**

---

## Increment 3 — the shared consent shell

### Task 3.1 — extract `showArtifactConsent` (behavior-preserving)
**Impl:** extract the reusable modal scaffolding from `showAgentInstallDialog` — overlay/card cssText, title, cancel/confirm, in-flight lock, `_skEsc` escaping, re-entry `prev.remove()` — into `showArtifactConsent({title, provenanceRow, body, confirmLabel, onConfirm, silent})`. Re-express `showAgentInstallDialog` as a caller that supplies the AI card body (behavior byte-identical — `tests/intelligence-drop.mjs` 38/0 is the proof). Silent classes (ingest) pass `silent:true` → no modal, but still flow the dispatcher + actor path.
**Test:** intelligence-drop 38/0 unchanged + a small block E asserting the shell's in-flight lock + cancel-inert on a trivial body.
Commit. (Skin compose stays silent/non-modal in v1 — matches the existing `/skin` UX; the shell is available for a future skin preview but not required.)

---

## Increment 4 — the `accepts` declaration

### Task 4.1 — seed-runtime `accepts` (dispatcher enforcement)
**Design:** an author declares `accepts` in the edit-unreachable `#rwa-affordances` declaration (extend the existing declared-facts read at :7128 with an `accepts:[{class,strict?}]` key). No declaration → accept-all, advisory.
**Test (block F):** dispatcher on an unlisted class → still runs, consent/status shows a soft "this document doesn't usually take &lt;class&gt;" note; a `strict:true` class or a frozen doc → refused with a clear reason, no side effect; no-declaration → all classes run silently.
**Impl:** a `resolveAccepts()` reading the declaration; `dispatchArtifact` consults it before routing.
Commit red then green.

### Task 4.2 (may defer) — thread `accepts` through self-description (4 sites)
**Scope flag:** reporting `accepts` in `rwa doc --json` + `runtime.describe()` touches the 4-site self-description contract (`docs/specs/rwa-self-description-spec.md`, `tools/self-description.mjs` oracle, `cli/src/identity.mjs` mirror, seed `runtimeDescribe`) with the `identity.test.mjs` deep-equal pins. This is the heaviest part and is NOT required for the bus to work. **Do it only if Increments 1-4.1 landed clean; otherwise defer to a fast-follow and note it.** If done: add `accepts` to the contract, update the oracle + cli mirror + spec, keep the 4 sites aligned, `cli/tests/identity.test.mjs` + `cli/tests/doc.test.mjs` green.

---

## Increment 5 — gate + docs
1. Full `tests/*.mjs` sweep (use a kill-capped runner; the jsdom suites hang at exit). All green.
2. `node --test cli/tests/*.test.mjs` (if 4.2 done) + `cd benchmark && npm run conformance`.
3. `node tools/regenerate-refs.mjs`; carriers still verify.
4. Spec: a short note in the self-description spec (if 4.2) + CLAUDE.md routing entry for the artifact bus (classifier/dispatcher/shell/accepts anchors + `tests/artifact-bus.mjs`).
5. `superpowers:finishing-a-development-branch`.

**Non-goals (do not build):** rwa-onto-rwa compose; the `transform` class; the `{theme}` skin-artifact variant; any droppable breaking single-file; a full `rwa-artifact/1` wire spec (v1 = the minimal tag only).
