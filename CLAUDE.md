# CLAUDE.md

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work.

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.
**This rule wins when it conflicts with Rules 4 or 12.**

## Rule 2 — Simplicity First
Minimum code that solves the problem. Nothing speculative.
No abstractions for single-use code.

## Rule 3 — Surgical Changes
Touch only what you must. Don't improve adjacent code.
Match existing style. Don't refactor what isn't broken.

## Rule 4 — Goal-Driven Execution
Define success criteria. Loop until verified.
Strong success criteria let Claude loop independently.

## Rule 5 — Use the model only for judgment calls
Use for: classification, drafting, summarization, extraction.
Do NOT use for: routing, retries, deterministic transforms.
If code can answer, code answers.

## Rule 6 — Keep context lean
Summarize and start fresh when the conversation grows long.
Surface the breach when context pressure forces shortcuts.

## Rule 7 — Surface conflicts, don't average them
If two patterns contradict, pick one (more recent / more tested).
Explain why. Flag the other for cleanup.

## Rule 8 — Read before you write
Before adding code, read exports, immediate callers, shared utilities.
If unsure why existing code is structured a certain way, ask.

## Rule 9 — Tests verify intent, not just behavior
Tests must encode WHY behavior matters, not just WHAT it does.
A test that can't fail when business logic changes is wrong.

## Rule 10 — Checkpoint after every significant step
Summarize what was done, what's verified, what's left.
Don't continue from a state you can't describe back.

## Rule 11 — Match the codebase's conventions, even if you disagree
Conformance > taste inside the codebase.
If you think a convention is harmful, surface it. Don't fork silently.

## Rule 12 — Fail loud
"Completed" is wrong if anything was skipped silently.
"Tests pass" is wrong if any were skipped.
Default to surfacing uncertainty, not hiding it.

---

## Repository contents

One line per file/dir. Versions and changelogs live in the specs and `git log`.

- `re-write-able-spec.md` — canonical container spec (source of truth).
- `rwa-edit-spec.md` — anchor-based edit protocol (`apply_edits`, `replace_document`).
- `rwa-edit-dsl-spec.md` — structural-transform DSL on top of rwa-edit/1 (surfaced as `apply_dsl_plan`).
- `docs/specs/rwa-lens-spec.md` — lens edit model (user-surface input replacing modal `⌘K`).
- `docs/specs/re-write-able-actions-spec-v0.7.md` — canonical action/skill/permission/Worker-mode spec. Earlier drafts (v0.1–v0.6.1-patch) and the working-method companions are read-only history.
- `docs/specs/rwa-intelligence-spec.md` — `intelligence/0.2`: a droppable, swappable (model + modify-prompt overlay) for a rewritable. Grounded on the built substrate — the overlay half **is** the v0.9 `rwa-agent/1` role (signed, frozen `#rwa-agents` zone, role-framed `modify()`, vault-narrowed, `describe()`-legible, revertible to the per-kind default); the model is `sessionStorage`-only, so an intelligence *recommends* a model, never carries one. Packaged as the **hybrid carrier**: a small `skill-host` rwa holding the signed record + a self-describing card, dropped via the file-drop→`runtime.agents.install` bridge (BUILT — `extractAgentEnvelopesFromCarrier`/`classifyInstallText`/`routeInstallFromText`/`handleCarrierDrop` in the seed beside `runtimePromptInstall`; capture-phase window drop; pinned by `tests/intelligence-drop.mjs`). Worked example: `examples/intelligence-carrier/concise-editor.html` (genuinely signed, jsdom-boot-proven). Supersedes the v0.7-citing `intelligence/0.1` draft.
- `docs/specs/rwa-product-types.md` — layer-cake taxonomy (substrate → graph → skill).
- `docs/specs/rwa-operations-api.md` — the surface-agnostic operations contract: names the five verbs (`bootstrap/import/modify/describe/publish`) every surface speaks, the three shared wire strings (`rwa-edit/1`, `rwa-edit-dsl/1`, `self-description/1`), and the operations×surfaces map. Routing index over the normative specs, not a restatement (the north-star keystone; companion to `docs/plans/2026-06-04-north-star-universal-surfaces.md`).
- `docs/specs/rwa-workflow-spec.md` — workflow product shape (linear / foreach / parallel primitives).
- `docs/specs/rwa-self-description-spec.md` — `self-description/1` contract: what a container reports it is (kind + affordances + baseline), across static / live / declared projections (the "a rewritable knows what it is" surface).
- `docs/specs/rwa-runtime-region-commit-spec.md` — `runtimeRegionCommit({regions,actor,reachability})`: the runtime-owned region commit primitive on top of R5. Lets the runtime (and only the runtime) rewrite a region the agent/lens can't touch — `reachability:'frozen'` (skill-zone persistence) scoped-bypasses the frozen guard for one region identity + re-asserts frozen; `'edit-reachable'` (default) is a plain region splice with NO live consumer today (skinning-v2 composes agent edits via `modify({compose})`, not this). Gate for actions-v0.8 §7. Implemented in the seed (`runtimeRegionCommit`), pinned by `tests/region-commit.mjs`.
- `docs/runtime-product-agnosticism-audit.md` — read-only audit; working document, not a spec.
- `seeds/rewritable.html` — **canonical bootstrap seed**. The service and the CLI both read this to emit fresh containers.
- `re-write-able-spec.html`, `hello.html` — worked-example references. Bootstrap mirrors `seeds/rewritable.html`.
- `service/` — zero-dep Node HTTP service: landing page, `/new`, `/import`, `/publish` (host-keyed shares), `/skill.zip`.
- `cli/` — `rwa` npm package. `rwa new`, `rwa import <file>`, and `rwa edit <file>`. Offline-first.
- `tests/` — jsdom + fake-indexeddb harness for the rwa-edit/1 modify pathway.
- `benchmark/` — fidelity + conformance harness. `npm run conformance`, `npm run fidelity:stub`, `npm run fidelity:dsl`.
- `tools/` — repo-level scripts: `regenerate-refs.mjs` (rebuild references from the seed) and `self-description.mjs` (the `self-description/1` reference oracle + validator).
- `README.md` — short pitch.

No build step for references/seed. No lint config at the repository level.

## Routing — when the user asks to edit X

- **Container spec** → `re-write-able-spec.md`. `.html` rendering is derived.
- **Edit protocol** → `rwa-edit-spec.md` (versioned `rwa-edit/N`).
- **DSL** → `rwa-edit-dsl-spec.md` AND `seeds/rewritable.html` (`compileDslPlan` block) AND `benchmark/oracles/dsl-compiler.mjs`. Three sites must stay aligned.
- **Lens edit model** → `docs/specs/rwa-lens-spec.md` AND `seeds/rewritable.html`. Regenerate references via `node tools/regenerate-refs.mjs`.
- **Runtime modes + inline manual edit (WYSIWYG leaf-text editing — dual-mode: direct text + `/`-prompt + selection voice commands)** → `seeds/rewritable.html` (the mode manager `runtime.mode`/`runtime.setMode`/`runtime.on('mode')`, `renderSkillsModePanel`/`renderActionsModePanel`, the `serializeLeafSafe`/`commitInlineEdit`/`runInlineCommand`/`resolveInlineEditTarget` block beside the lens-anchor code, the selection command surface `resolveSelectionCommandTarget`/`runSelectionCommand`/`startSelectionVoice`, + the mode-gated `pointerdown`/`dblclick`/`keydown` registrations in `renderDoc`) AND `docs/specs/rwa-lens-spec.md` §4.5/§5.1 (Document/Edit/Skills/Actions boundary, leaf-click edit vs container-click anchor + dual-mode/selection-command notes) AND `docs/plans/2026-06-08-inline-manual-edit-design.md` (direct-text design) + `docs/plans/2026-06-09-inline-lens-dual-mode-design.md` (prompt-mode design). Pinned by `tests/mode.mjs`, `tests/inline-edit.mjs` (90/90; prompt mode = blocks C1–C5; selection/voice = E0c–E0e), and active-view inertness in `tests/view.mjs`. Fresh boot starts in Document mode. Direct text rides the existing non-agent commit path (`runtimeApplyEnvelope`, actor `user:edit-surface`); a leading `/` (`\/` escapes) flips the session to prompt mode — Enter routes the instruction to the lens's block-scoped `runAnchoredCommand` (`surface:'anchored-command'`), Esc demotes to literal text, blur discards; edit entry is gated on `mode === 'edit' && !activeView && !modifyMutex`. Selection commands are Edit-mode-only, runtime chrome only, deterministic first (`make it bold`/italic/code), and commit with `surface:'selection-edit'` (`actor:'user:selection-command'` or `user:voice-selection`). It is NOT a lens mode. Editable set = leaf-text members of `ANCHORABLE_TAGS` (`p`/`h1-6`/`blockquote`/`li`/`td`). Regenerate references after a seed change.
- **Images (embedded images / rwa-asset tokens / drag-drop-paste-/image insert)** → `rwa-edit-spec.md` §19 (the normative virtualization contract: data-URI storage, `rwa-asset:<hash8>` token grammar, caps-on-virtual-form, `unknown_asset_reference`, orphan tolerance, no-assets new-token guard) AND `docs/specs/rwa-lens-spec.md` §6.3 (insert surfaces) AND `seeds/rewritable.html` (three blocks: `virtualizeImages`/`expandImages`/`assertNoNewAssetTokens` beside `containsReservedMarker`; ingestion `ingestImageFile`/`RWA_IMG` + Edit-mode-only insert surfaces `insertImageAt`/drop/paste/`openImagePicker`/hover-toolbar (S/M/L resize + ✕) after the inline-edit block; `opts.{assets,orphans}` threading in `applyEdits`/`replaceDocument`/`commitDoc`/`commitCore`/`modify`/`modifyViaBridge`/`runAnchoredCommand`) AND `docs/plans/2026-06-10-images-in-rewritables-design.md` (rationale). Pinned by `tests/image-assets.mjs` (blocks A–H; switches to Edit mode before GUI affordance tests). Image bytes live in the doc (single-file invariant untouched); the agent and the size caps only ever see tokens; GUI inserts + resize ride the non-agent commit path (actors `user:image-{drop,paste,picker,delete,resize}`). Hosted-sink envelopes are expanded; the hosted `/modify` re-virtualizes them server-side (`applyPlan opts.virtualizeEnvelope` in `service/server.js handleHostedModify`, bounded by `MAX_DOC_EXPANDED`=10 MB) — so hosted image inserts work (`docs/plans/2026-06-10-hosted-images-design.md`). CLI mirror: `cli/src/apply-edits.mjs`/`agent-loop.mjs` (re-mirror when the seed blocks change; service re-vendors per `VENDORED.md`). Regenerate references after a seed change.
- **Action/skill/permission/Worker-mode** → `docs/specs/re-write-able-actions-spec-v0.7.md`. Preserve cluster structure (§11.9, §11.10, §11.12). Bump to v0.8 if scope exceeds v0.7. NOTE: `docs/specs/re-write-able-actions-spec-v0.8.md` is the **built** spec (skill-host kind, every-skill-in-a-Worker, two permission tiers, static worker-scoped CSP, vault, runtime-sole-writer frozen zone — browser-proven, `tests/skill-*`). The items v0.8 §11 **deferred to v0.9+** are specified in `docs/specs/re-write-able-actions-spec-v0.9.md` (the numbered v0.9 spec; 13 items: update-diff/re-affirm UI, CLI `rwa install`, confusables+name_history, `bus:`/`fsa:`/`idb:` tiers, view/edit-surface skills, `hook` kind, Worker pool, signed-skill marketplace, multi-agent orchestration, Argon2id, account identity; §15 invariants 21–46). **All 13 are BUILT + browser-proven + shipped** (the doc's build-status paragraph records per-item refinements). The draft was promoted to the numbered `re-write-able-actions-spec-v0.9.md` (from `…-v0.9-open-items.md`) on 2026-06-26.
- **Vault / credential store / KDF / Argon2id** → `docs/specs/re-write-able-actions-spec-v0.8.md` §6 (the PBKDF2-200k+AES-GCM machine-local credential store) AND `docs/specs/re-write-able-actions-spec-v0.9.md` §13 (I9 — the `kdf_version` upgrade to Argon2id) AND `seeds/rewritable.html` (the `// ─── Vault` block: `ARGON2_SRC` marker-region + `_argon2idViaWorker`/`_argon2idHash`/`_vaultDeriveKey(…,kdfVersion=0)`/`runtimeVaultUnlock(passphrase,{targetKdfVersion})` + the skill-host "Upgrade to Argon2id" settings button) AND `docs/plans/2026-06-23-i9-argon2id-kdf-design.md` (the pure-JS-not-WASM rationale). **Argon2id is pure-JS** (vendored `@noble/hashes` v2.2.0 via `tools/vendor-argon2.mjs`, inlined as the string `ARGON2_SRC`, RFC-9106-pinned) so the **frozen CSP is unchanged** (Inv 26/44/18 held — adding `'wasm-unsafe-eval'` is forbidden); the ~1.5 s derive runs in a `blob:` Worker. record = `{salt, kdf_version, check, entries}` (0=PBKDF2, 1=Argon2id, missing→0, unknown→`vault_unknown_kdf_version`); new vaults default to v1; migration is atomic (one record write, key assigned only after the put). **Vault is seed-only** (no CLI/service mirror). Pinned by `tests/vault-kdf.mjs` (jsdom sync fallback via `tests/lib/argon2-fallback.mjs` — jsdom has no Worker) + the `blob:` Worker path is browser-proven; I13 `tests/vault-export.mjs` + `tests/vault.mjs` carry the same shim. Regenerate references after a seed change.
- **Product-type taxonomy** → `docs/specs/rwa-product-types.md`. Route to owning spec; don't restate.
- **Intelligence (droppable model+overlay / swappable ⌘K behavior)** → `docs/specs/rwa-intelligence-spec.md` (`intelligence/0.2`). The overlay is the v0.9 `rwa-agent/1` role (see the Action/skill routing above + `runtime.agents.*` / `buildAgentZone` / `getActiveActor` in the seed); the model stays `sessionStorage`-only (recommend, never carry). Worked carrier: `examples/intelligence-carrier/concise-editor.html` (signed + jsdom-boot-proven; regenerate with `node tools/regenerate-refs.mjs` after a seed change — it's wired in as a skill-host ref and preserves the signed record). The **file-drop install bridge is BUILT** (§5; seed `extractAgentEnvelopesFromCarrier`/`handleCarrierDrop` beside `runtimePromptInstall`, un-escapes a dropped carrier's INLINE_DOC + parses its `#rwa-agents` zone → consent dialog → `runtime.agents.install`; pinned by `tests/intelligence-drop.mjs`). **I-A (recommend-a-model-on-activation) is BUILT** (§6; seed `getRecommendation`/`applyRecommendation`/`offerRecommendedModel`/`runtimeActivateAgent` + the Activity-panel *Intelligences* activate section; recommended_model/backend ride the rwa-agent/1 **envelope** OUTSIDE the signed `agent` — no canon change, signature still verifies, seed-only; applied to sessionStorage `rwa_model`/`rwa_backend` only, enum-validated, behind consent, never base-URL/key; pinned by `tests/intelligence-model-rec.mjs`). **I-E (blended overlays) is BUILT** (§6; merge model B = primary + advisory: `activeAgentRole` is the primary unchanged + an in-memory `advisorRoles` set — verified-only, capped 3, ephemeral — whose prompts append as a subordinate block in `resolveSystemPrompt` via `_agAdvisorBlock`; `runtime.agents.{addAdvisor,removeAdvisor,advisors}` + the Activity-panel advisor controls; **vault stays primary-only** because `_agVaultAllowed` reads the active record, never advisors; pinned by `tests/intelligence-blend.mjs`; design `docs/plans/2026-06-27-intelligence-blended-overlays-design.md`). **I-C (CLI authoring scaffold) is BUILT**: `rwa intelligence new <role> --prompt …` (`cli/src/intelligence.mjs`, bin `verb==='intelligence'`) mints a signed `rwa-agent/1` + scaffolds a carrier (skill-host) + writes the private key to a sibling `.key.json`; reuses the canon (no `intelligence/1` fork); pinned by `cli/tests/intelligence.test.mjs`. **I-D (advisory kind-affinity) is BUILT**: an unsigned `affinity` envelope field → `getAffinity`/`affinityWarning` warn (never block) on a `PRODUCT_KIND` mismatch + panel surfacing; pinned by `tests/intelligence-affinity.mjs`. Forward now: only **I-B** (cross-machine config), recommended *against* (key-redirection vector). Don't restate the actions/self-description specs — cite them.
- **Operations-API overview / "what contract does surface X speak" / adding a new surface** → `docs/specs/rwa-operations-api.md`. Index only — it names the five verbs + shared wire strings and points to owning specs. A change to an actual operation's contract belongs in the owning spec it points to (and its mirrors), then reflect the naming here. Don't restate spec internals.
- **Workflow product shape** → `docs/specs/rwa-workflow-spec.md` AND `cli/src/seed.mjs` (`KIND_WORKFLOW_BODY`) AND `SYSTEM_PROMPTS.workflow` in `seeds/rewritable.html`. Three sites must stay aligned. Regenerate references after.
- **Self-description / affordances** → `docs/specs/rwa-self-description-spec.md` (the `self-description/1` contract) AND `tools/self-description.mjs` (the reference **oracle/source**: `KIND_PROVIDERS`, `validateSelfDescription`, `checkAffordanceAgreement`, `parseDeclaration`, `declarationFacts`) AND `cli/src/identity.mjs` (publish-time mirror, pinned by `cli/tests/identity.test.mjs`) AND `seeds/rewritable.html` (`runtimeProvide`/`runtimeDescribe` — the live registry∪declaration union, mirrors the declaration helpers). **Four sites must stay aligned**; the oracle is the source, the others mirror/consume it. Provider kinds: `view`/`edit-surface`/`compute` (`tool`/`hook` deferred); custom kinds get `[]` static (honest), `declared > live > static` precedence. Regenerate references after a seed change.
- **Runtime-owned region commit** → `docs/specs/rwa-runtime-region-commit-spec.md` (the `runtimeRegionCommit` primitive) AND `seeds/rewritable.html` (`runtimeRegionCommit` beside `commitCore`; `commitCore`/`replaceDocument`/`dataRwaFrozenSnapshot` carry an optional `frozenBypass`/`bypassIds` param — additive to the R5 path, every existing caller byte-unchanged) AND `tests/region-commit.mjs` (the pinning test). Builds on R5 (`docs/plans/2026-05-30-r5-write-path-design.md`). `frozenBypass` is set ONLY by `runtimeRegionCommit` — the agent's apply_edits/replace_document never pass it, so the frozen wall holds for the agent. Consumers call it; they don't reimplement it — skill persistence uses `reachability:'frozen'` (actions-v0.8 §7, `buildSkillZone`). `'edit-reachable'` currently has NO live consumer: skinning-v2 L1 composes agent edits via `modify({compose})` + `replaceDocument` (see **Skinning** below), not this primitive.
- **Skinning (skins / style library)** → `docs/plans/2026-06-03-skinning-design.md` (design) AND `cli/src/skins.mjs` (canonical 5-preset `SKINS`: `name/label/swatch/theme`; `theme` carries the `sk-*` L1 CSS) AND `seeds/rewritable.html` (`RWA_SKINS` byte-mirror of `SKINS`, pinned by `cli/tests/skins-seed-mirror.test.mjs`; `applySkin`/`resetSkin` = L0 theme-only; `applySkinL1` + **seed-only** `RWA_SKIN_RECIPES` + `spliceSkinBlock` = L1; the ✦ gallery swatch + `/skin NAME` lens drive `applySkinL1`). **v2 = always-on L1 content-aware restyle** via the **compose-then-commit primitive**: `applyEdits(…,{noCommit})` + `modify(instr,lensMeta,{compose:{transform,reason}})` run the agent no-commit, splice the deterministic theme block, and commit theme + agent `sk-*` wrappers as ONE `replace_document` (one rwa_undo frame / one ⌘Z, actor `skin:NAME`). Agent decline/unreachable degrades to a theme-only commit (still ONE commit); a genuine commit failure propagates so callers react. The agent can't inject `<style>`/`<script>` — `computeShape` blocks it in the no-commit apply; only the runtime adds the theme block. `sk-*` CSS is `#rwa-doc-mount`-scoped, no `!important`; recipes are additive-only/1:1-invertible. **Re-skin de-skin is DETERMINISTIC** — `deskinDoc` (parser-free balanced-tag unwrap of pure `sk-*` div/span wrappers + class-strip + theme-block removal) runs on the base before the agent (`modify` opts `baseDoc`/`commitBase` → one ⌘Z reverts to the prior skin); `resetSkin` reuses it. **CLI**: `rwa skin <file> NAME --l1` mirrors the compose path (`deskinDoc` + `RWA_SKIN_RECIPES` + `RWA_SKIN_L1_PREAMBLE` mirrored byte-identical to the CLI, pinned by `cli/tests/skin-l1-seed-mirror.test.mjs`; agent-unreachable → loud exit 4 since the CLI has no bridge fallback); default `rwa skin` stays theme-only (offline-first). **v3** `/skin like <description>` → `validateSkinTokens`/`synthesizeSkinTheme`/`sanitizeSkinName` (a model-extracted token set → a safe synthesized `<style data-rwa-skin>` theme; 3-layer injection defense: hex/enum whitelist + system-font intents + a fail-loud scrub rejecting url/@import/@font-face/http/script-style-tags/!important) → the same compose-then-commit with `RWA_SKIN_GENERIC_RECIPE`. **Deferred (v3.1)**: the IMAGE front-end (drag-drop + per-backend `image_url`/VLM/bridge-degrade — the extractor/synthesizer already take image-derived tokens unchanged) and CLI v3. Pinned by `tests/skin-compose.mjs` (89/89) + conformance SKIN-01/02/03. Regenerate references after a seed change.
- **Sharing (connected share / ↗ panel / share URL)** → `re-write-able-spec.md` §5.11 (normative: the three gestures, machine-local `share_conn` record in `rwa_state`, version-not-live framing, fresh-UUID-per-publish, durable-while-active TTL) AND `seeds/rewritable.html` (the `// ─── Connected share` block: `shareCreate`/`shareUpdate`/`shareUnshare`/`renderSharePanel` + the ↗ button/panel in `buildUI`) AND `service/server.js` (the `/share` route family beside `POST /publish`, which stays untouched: create/update/delete, CORS for the `file://` seed, `shareExpired` two-class sweep). Rationale: `docs/plans/2026-06-11-save-affordance-framings.md` (§7c — local-first framing, TTL decision). Pinned by `tests/share.mjs` + `service/tests/share.test.mjs`. The token is a capability: `rwa_state` only, never in the DOM, never in the file. Distinct from `rwa publish` (ephemeral 24h, no update) and `/r/` hosted-edit (live writable projection — the canon moves). Regenerate references after a seed change.
- **Hosted-edit runtime (writable hosted projection / `/r/` routes)** → `service/server.js` (the `/r/` HTTP API: `POST /r` ingest, `GET /r/:id`, `/r/:id/{describe,export,doc,modify,undo,rotate}`, `DELETE /r/:id`) AND the design/build docs `docs/plans/2026-06-07-hosted-edit-foundation-{design,build-design,build-plan}.md` (route here, don't restate). `/r/` is a NEW reserved URL prefix — disjoint from `/s/` publishing. `/modify` is server-authoritative `rwa-edit/1` apply via `service/lib/*` (**vendored byte-identical mirrors of `cli/src`** — apply pipeline + identity; cmp-gated by `service/tests/vendored-apply.test.mjs`; re-vendor when `cli/src` changes, see `service/lib/VENDORED.md`). The hosted runtime hangs off **two guarded seed seams** (both additive, byte-identical when unset): `window.__rwaCommitSink` in `commitDoc` (the live projection redirects the in-page commit to a server-authoritative apply) and `window.__rwaSuppressBlockIds` at boot (serves the un-blessed hosted body so `baseHash` matches the stored bytes). **CLI ingest verb**: `rwa host <file>` pushes a rewritable into the hosted runtime. Service is model-free — the agent runs client-side; `/modify` only applies the envelope it's handed. Known v1 limitations live in the build-design doc's "Known limitations (v1)".
- **Bootstrap** → `seeds/rewritable.html` (canonical). Regenerate `hello.html` and `re-write-able-spec.html` by substituting `DOC_UUID`, `FILE`, and `INLINE_DOC` body into the seed.

## What re-write-able is (architecture in one page)

**Three architectural layers, stacked.** The substrate (this seed + bootstrap) renders, edits, commits, and exports the document. Above it is the **graph layer** (`rwa-graph/1`, deferred): multi-stage workflows with durable per-item state. Above that is the **skill layer** (`docs/specs/re-write-able-actions-spec-v0.7.md`): permission-gated skills with vault, bus, install dialog, Worker-mode. Document, app, and tree-of-steps workflows live at substrate; multi-stage workflows at graph; multi-agent workspaces at skill.

A re-writeable file is a single self-contained `.html` that renders, stores, modifies, and exports itself with no server. Inside one `<script id="rwa-bootstrap">`:

```
container.html
├── DOC_UUID            — per-container UUID, baked at creation
├── INLINE_DOC          — frozen snapshot of the document (template literal)
└── runtime + loader    — IDB helpers, FSA commit, ⌘K/⌘Z/⌘S, agent call
```

The bootstrap is immutable. **Only the contents of `INLINE_DOC` change between commits.** `DOC_UUID`, loader, and runtime bytes are byte-identical from open to commit to next open.

### The rewrite loop (rwa-edit/1)

`⌘K` → acquire modify mutex → read current doc from IDB (LF-canonical) → call agent with `apply_dsl_plan`, `apply_edits`, `replace_document` (multi-turn tool-use, retry budget 3) → on success: atomically commit `(rwa_doc, rwa_undo, rwa_hist)` in one IDB transaction → re-render → release mutex.

`⌘Z` pops `rwa_undo`. `⌘S` rebuilds the file (FROZEN bytes + `escapeForTL(currentDoc)` between INLINE_DOC backticks) and writes it: in-place via FSA on Chromium, downloaded blob otherwise. The agent never sees the bootstrap — only the document.

Tools, in preference order:
- `apply_dsl_plan` — structural transforms; deterministic compile to `apply_edits` (or `replace_document` for the escape op).
- `apply_edits` — content transforms; `(find, replace)` pairs on unique anchors.
- `replace_document` — escape hatch with required `reason`. **No silent escalation** from `apply_edits`/DSL after retry exhaustion.

All successful tool calls land in `rwa_hist` as `kind: 'edit_batch'` (DSL flattens to its compiled apply_edits form) or `kind: 'replace_document'`.

### Per-container IndexedDB

Every container's private IDB lives under `rwa_<DOC_UUID>` — namespaced by the build-time UUID so containers under `file://` (null origin) don't shadow each other.

| Tier | Where | Holds |
|---|---|---|
| **Per-container IDB** (`rwa_<DOC_UUID>`) | private | `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_fsa`, plus document-defined stores |
| **Shared IDB** (`rwa_shared`) | opt-in | `runtime.shared.*` — composition surface (spec §5.7, §11.5) |
| **OPFS** (`_<DOC_UUID>/`) | per-container, in the shared null origin | binary blobs (via `runtime.fs.*`) |
| **sessionStorage** | per tab | API key, backend choice, base-URL overrides, model — never persisted |
| **Filesystem** | the container itself | bootstrap with current `INLINE_DOC` |

**Reserved namespaces** — runtime-only:
- IDB databases: `rwa_<DOC_UUID>`, `rwa_shared`
- IDB stores in `rwa_<DOC_UUID>`: `rwa_*`
- `rwa_hist.kind`: `"edit_batch"`, `"replace_document"`
- OPFS: `_rwa/`
- HTML id: `#rwa-doc-mount`
- Comment prefixes in the doc: `<!-- rwa:`, `/* rwa:`, `// rwa:` and `rwa:frozen:begin <name>` / `rwa:frozen:end <name>`
- Attributes: `data-rwa-frozen` (frozen-zone declaration); `data-rwa-id` (runtime-assigned stable block id, backfilled at boot + every commit, skipping frozen zones — agent must preserve verbatim)

**The bootstrap is the anchor.** Never in IDB, never visible to the agent. If something goes wrong, reload the file; the inline snapshot is the last known good state.

### Agent contract

System prompt is **editor-first**: surgical edits to an existing document. Three tools (above). The runtime drives a multi-turn tool-use conversation; on failure (`find_not_found`, `find_not_unique`, `frozen_zone_violation`, `structural_shape_changed`, etc.) the structured failure feeds back as `tool_result` for up to 3 attempts. After exhaustion, the user sees the failure code. No silent escalation.

The agent receives only the document (LF-canonical text inside `#rwa-doc-mount`) and the list of frozen-zone names. Must not produce reserved marker substrings in `find` or `replace`. **Frozen zones are author-declared invariants**; changing them requires external editing of the container file.

`SYSTEM_PROMPT` resolves at module load via `SYSTEM_PROMPTS[PRODUCT_KIND] || SYSTEM_PROMPTS.document`. Per-kind framing lives in the `SYSTEM_PROMPTS` registry; the shared `SYSTEM_PROMPT_RULES` block carries tool rules, DSL syntax, frozen-zone rules, and `data-rwa-id` guidance — one source of truth so a tool-rule change lands across all kinds. `TOOL_SCHEMAS` remain a single constant (wire-format shape, not framing). Each prompt must match `rwa-edit-spec.md` §8/§9.1 AND `rwa-edit-dsl-spec.md` §3/§4.

Extract-marker pairs (`// rwa:extract:begin <NAME>` / `// rwa:extract:end <NAME>`) wrap `SYSTEM_PROMPTS`, `SYSTEM_PROMPT_RULES`, and `TOOL_SCHEMAS` so `cli/src/seed-extract.mjs` can parse them. Preserve marker pairs when renaming/restructuring (or update both seed and extractor).

`rwa_hist` records may carry an optional `actor` field (free-form string: model id for command paths, `user:lens` for direct-text paths, `bridge:claude-p` for bridge). Pre-actor records render correctly.

### Agent backends

Five backends, all routing through the same `modify()` lifecycle:

| Backend | Transport | Multi-turn tool-use? | Setup |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1/chat/completions` with `Bearer <key>` | yes | API key in settings |
| `ollama` | `http://localhost:11434/v1/chat/completions` (override-able) | yes | `OLLAMA_ORIGINS=*` |
| `lmstudio` | `http://localhost:1234/v1/chat/completions` (override-able) | yes | CORS enabled in Developer tab |
| `atomic` | `http://127.0.0.1:1337/v1/chat/completions` (override-able) | yes | atomic.chat running locally; CORS allows http(s) origins but NOT `file://` (null origin) — serve the container from an origin |
| `bridge` | `POST http://127.0.0.1:8765/run` shelling out to `claude -p` | no (single-shot envelope) | run web_cli_bridge locally |

The first four share `resolveBackendConfig()` → `openAiCompatChat()`. Base URLs for `ollama`/`lmstudio`/`atomic` are overridable (sessionStorage `rwa_base_url_<backend>`). The settings "Test" button probes `GET <baseUrl>/models` and populates a `<datalist>`. `bridge` runs single-shot: `claude -p` has no mid-stream tool_calls, so the model emits an rwa-edit/1 envelope as text dispatched through the same apply* machinery. Backend routing is pinned by `tests/backends.mjs` (an unwired backend name silently falls back to openrouter — the privacy trap that test exists to catch); CLI mirror in `cli/src/backend.mjs` + the allowlists in `cli/bin/rwa.mjs`/`cli/src/commands.mjs`.

### Commit (`⌘S`)

```js
buildFile(currentDoc) =
  FROZEN.slice(0, after_INLINE_DOC_backtick) +
  escapeForTL(currentDoc) +
  FROZEN.slice(closing_INLINE_DOC_backtick);
```

`escapeForTL` escapes `\`, `` ` ``, `${`, `</script`. The closing-backtick locator walks the literal honoring backslash escapes. The `FileSystemFileHandle` is structured-cloneable in modern Chromium and lives in `rwa_<DOC_UUID>.rwa_fsa`. Permission can lapse — fall back to download mode and surface a regrant affordance.

### Design constraints for documents

- Single self-contained file; CSS inline; JS inline only when interactive.
- No React, no npm, no build steps. cdnjs only when genuinely needed.
- Light theme palette (playground.ikangai.com-aligned): grayscale ramp `--gray-50…--gray-900` plus semantic `--green/--yellow/--red/--blue`. Legacy aliases (`--bg`, `--surf`, `--b1`/`--b2`, `--text`, `--muted`, `--accent`) resolve to the ramp. Primary action color is `--gray-900`. Lens chrome: floating 680px white card, 24px radius, 1px `--gray-200` border, docked at `bottom:24px` (`body` gets `padding-bottom:160px`).
- Baseline content typography in the seed bootstrap via `:where(#rwa-doc-mount) …` (specificity 0, so document `<style>` always wins). `article` defaults to `max-width:720px; margin:64px auto; padding:0 32px;`.
- Print stylesheet ships `@page { margin:18mm; }` plus `@media print` rules (hide `#rwa-runtime`, break-control, force black links, `print-color-adjust:exact`, hide blank-doc `.placeholder`).
- Fonts: system stack only. `--font-ui` and `--font-mono`. No web fonts.
- Real seed data, never lorem ipsum.
- Pure-prose documents are valid: one `<article>`, a stylesheet, no JS.

### Platform reality

iOS Safari evicts IDB aggressively. The `navigator.storage.persist()` request and the dirty-state nudge exist because of this. **The exported `.html` on disk is the only durable artifact** — every runtime change should preserve or strengthen that escape hatch. Private/incognito is explicitly unsupported; detect and message clearly.

## Spec invariants (load-bearing)

Listed in the spec's "Invariants" section. Flag any proposed change explicitly:
- Bootstrap is byte-identical except for `INLINE_DOC` contents.
- Each container has its own UUID and IDB.
- Runtime is never in IDB and never visible to the agent.
- Reserved stores are runtime-only.
- Commits do not carry undo state.

The spec is versioned in its closing line. Bump it on material changes; update the trailing summary. Cross-references use `§N.M`.

## References — regeneration flow

- `hello.html` and `re-write-able-spec.html` share their bootstrap with `seeds/rewritable.html`. Update by **regenerating from the seed**: read the reference's existing `DOC_UUID` and `INLINE_DOC` content, copy the seed wholesale, then substitute `DOC_UUID`, `RWA.FILE`, and the `INLINE_DOC` body back in.
- Each reference ships with its own `DOC_UUID`. Never reuse. Generate fresh: `node -e 'console.log(crypto.randomUUID())'`.

## CLI conventions (`cli/`)

- Offline-first. `rwa new` and `rwa import` must work without network. Don't fetch the seed at runtime.
- **`rwa clone <url>` is the network-bearing sibling of `import`** — it fetches a public webpage, extracts the main article + title, sanitizes it (reusing `import.mjs`'s exported `sanitizeImportedHtml`), and bootstraps a rewritable. It is the **only** CLI command that does network I/O, so the offline-first rule above explicitly excludes it. Pipeline split across three modules: `cli/src/fetch-page.mjs` (`fetchPage` for HTML + `fetchImageDataUri` for `--localize-images`, both over the shared SSRF-guarded `fetchValidatedBytes` core — http/https only, blocks loopback/private/link-local/reserved + IPv4-mapped/NAT64/6to4 IPv6 + multicast, DNS-rebinding re-resolution, manual per-hop redirect re-validation, body/redirect caps; throws `CloneError`), `cli/src/clone-extract.mjs` (`extractArticle` — parser-free balanced-tag extraction; WordPress `.entry-content`/`<article>` profiles + text-density fallback), and `cli/src/clone.mjs` (`cloneFromHtml`/`cloneCmd` — wraps content in `<article>` with a prepended `<h1>` title + provenance footer, then the standard `applySeedSubs`+`replaceInlineDoc` bootstrap). Content-only by default (no style/skin extraction — leans on the ikangai-aligned baseline). **`--localize-images`** (`localizeImages` in `clone.mjs`) makes a clone self-contained: each remote `<img src>` is fetched via `fetchImageDataUri` and inlined as a `data:` URI (image/* only, raw bytes — the CLI has no canvas to recompress), bounded per-image (2 MB) and total (8 MB), GRACEFUL (a failed/oversized/non-image/over-budget fetch leaves that `<img>` remote + warns — one bad image never fails the clone). `CloneError` surfaces as `file_error/<subcode>` (exit 2) in `bin/rwa.mjs`.
- **`rwa publish-site <file>` is the durable counterpart to `rwa publish`** (`cli/src/publish-site.mjs` → `publishSite`). Where `rwa publish` POSTs to the service for an ephemeral 24h share, `publish-site` scps the file VERBATIM onto a static site and returns the live URL. Config is flags-over-env: `RWA_SITE_HOST`/`RWA_SITE_PATH`/`RWA_SITE_URL` (overridable by `--host`/`--path`/`--url`); nothing is baked into the package. Network-bearing (offline-first excludes it, like `clone`). Security: transport is `execFile('scp', ['--', <abs source>, host:path/name])` — an argument array, never a shell string; the remote name is `basename` + `/^[A-Za-z0-9][A-Za-z0-9._-]*\.html$/`, which blocks both path traversal and shell-token injection at one gate; the published bytes carry no secret (a rewritable never stores the API key, sessionStorage only). Failure surface mirrors `publish.mjs`: exit 2 file_error, exit 1 usage (config_error/invalid_name render as `usage_error/<subcode>`), exit 4 `publish_error` (carries scp's stderr verbatim). Transport is injected (`{execFile}`) so `cli/tests/publish-site.test.mjs` runs offline.
- Seed-load order: `cli/seeds/rewritable.html` (in-package, created by prepublish) → `seeds/rewritable.html` (dev fallback). Don't add candidates without thinking through `npm publish` interaction.
- The CLI mirrors three pieces of bootstrap logic: `escapeTL`, the INLINE_DOC backtick-walk, and the DOC_UUID substitution regex. If any change in `seeds/rewritable.html`, mirror in `cli/src/seed.mjs`.
- Product-kind machinery: `rwa new --kind <name>` substitutes six regions via `kindOverrides(kind)` in `cli/src/seed.mjs` — INLINE_DOC body, `LENS_PLACEHOLDER`, `LEGACY_PAL_PLACEHOLDER`, `PRODUCT HEADER` comment, `PRODUCT_KIND`, `LENS_CLICK_TO_ANCHOR`. Adding a kind = one entry in `KIND_TABLE` + one in `SYSTEM_PROMPTS` + a line in `cli/README.md` and `cli/bin/rwa.mjs`. `workspace` also has `cli/src/workspace.mjs` and `rwa workspace create|sync`, which generate `rwa-index.html` from sibling rewritables. `applySeedSubs` enforces exactly-one match per region.
- `rwa import` ordering: apply seed-level substitutions (DOC_UUID/title/FILE) on the pristine seed first, *then* drop imported content into INLINE_DOC. Reversed order causes DOC_UUID substitution to false-match imported content.
- HTML import keeps `<script>` tags intentionally (rwa documents can be interactive) and prints a stderr `note:` warning. Don't strip silently.
- **`rwa edit` is the canonical programmatic edit entry point** for the CLI. Three invocation forms — positional instruction (agent loop), piped envelope on stdin, or `--plan <file>` — all funnel through the same `applyPlan` in `cli/src/edit.mjs`. Exit codes `0`/`1`/`2`/`3`/`4` (success / usage / file / envelope / agent) are stable. `--json` mode emits one JSON object per line on stderr for structured failure + retry reporting. The instruction path drives `cli/src/agent-loop.mjs` against an OpenAI-compatible backend (openrouter / ollama / lmstudio).
- **`rwa doc` is the read counterpart to `rwa edit`** (`cli/src/doc.mjs` → `inspectDoc`). Plain mode prints the LF-canonical editable body (the exact text the edit contract operates on, ± one trailing newline); `--json` emits a **`self-description/1` superset** of the editing contract on stdout — the prior `{rewritable, uuid, kind, frozenZones, length, doc}` plus the self-description fields `{rwa, source:"static", title, blocks, affordances, baseline}` ("what is this, what can be done with it" — `docs/specs/rwa-self-description-spec.md`). It reuses `extractInlineDoc` + `findFrozenZones` and the `edit.mjs` `CliError` so the `file_error` surface (`not_found`/`read_error`/`not_a_rewritable`, exit 2) is identical across read and write. stdout is reserved for the document/contract; all errors go to stderr. Never reads stdin, never writes the file. The `DOC_UUID`/`PRODUCT_KIND` extraction regexes mirror `seed.mjs` and `rwa.mjs detectProductKind` — keep them in step.
- **`cli/src/identity.mjs` is a publish-time mirror of `tools/self-description.mjs`** (the self-description/1 reference + referee oracle). The CLI can't reach repo-root `tools/` after `npm publish`, so `KIND_PROVIDERS`, `SUBSTRATE_BASELINE`, title/blocks extraction, the assembled static projection, **and the v1.1 declared-read** (`DECL_RE`, `parseDeclaration`, `declarationFacts`, `validateSelfDescription`, `resolveSelfDescription`) are duplicated in `identity.mjs` (same pattern as `apply-edits.mjs` mirroring the seed). No `cmp` gate — the mirror is pinned by test: `cli/tests/identity.test.mjs` deep-equals `KIND_PROVIDERS`/`SUBSTRATE_BASELINE` + `validateSelfDescription` (across valid + every failure mode) + `declarationFacts`/`parseDeclaration` against the reference, and `cli/tests/doc.test.mjs` deep-equals the whole `rwa doc --json` projection against `computeSelfDescription`. Drift fails the suite. When `tools/self-description.mjs` changes, re-mirror `identity.mjs`. **`rwa doc`/`rwa ls` apply the v1.1 precedence (`resolveSelfDescription`: `declared > static`)** — a trustworthy embedded `#rwa-affordances` declaration (edit-unreachable: outside `INLINE_DOC` or `data-rwa-frozen`, the latter now CLI-enforced) wins over the kind-template guess and emits `source:"declared"`; uuid/frozenZones/blocks are always filled from the bytes (container facts, authoritative over author claims); a non-conforming or edit-reachable declaration safely falls back to `source:"static"`. The runtime producer (`runtime.describe()` in the seed) emits the same shape live (registry∪declaration).
- `cli/src/dsl-compiler.mjs` is a **publish-time snapshot** of `benchmark/oracles/dsl-compiler.mjs` — do not hand-edit. The `prepublishOnly` script runs `cmp` BEFORE `cp`, so drift between the two fails the publish loudly rather than being silently overwritten. To roll a deliberate change, edit `benchmark/oracles/dsl-compiler.mjs` (the canonical site) and let the next publish refresh the snapshot.
- `cli/src/apply-edits.mjs` is **hand-mirrored** from `seeds/rewritable.html`'s validator + apply path (frozen-zone detection, reserved-marker check, structural-shape preservation, find/replace splice). Mirror manually when the seed changes — there is no cmp gate. Both frozen-zone forms are now enforced: **marker-form** (`<!-- rwa:frozen:begin/end -->`, via `findFrozenZones` per-edit crossing) AND **attribute-form** (`data-rwa-frozen`, via `dataRwaFrozenSnapshot` batch-level snapshot-equality, mirroring the seed's `dataRwaFrozenSnapshot` :2971 — parser-free `tag\0outerHTML` set, rejected as `frozen_zone_violation` `form:'attribute'`). The reserved-substring check additionally blocks edits whose `find`/`replace` literally mentions `data-rwa-frozen`. **Reporting** stays marker-form-only on purpose: `findFrozenZones` (→ `rwa doc`/`ls` `frozenZones`) mirrors the seed's `extractFrozenZones` (also marker-only), so the static and live `frozenZones` agree (SD-04). Size caps (`MAX_REPLACE`/`MAX_DOC`), `canonLF` normalization, lone-surrogate, class-lock (both coverage AND apply-path crossing), and reserved-id are now all mirrored (2026-06-10). The **sole deliberate scope-down** is `parse_error_post_apply`: the CLI is parser-free by design, so it relies on `structural_shape_changed` + tag-balance rather than a `DOMParser` round-trip. Two regex limits the CLI previously inherited (unquoted `class=rwa-locked`, self-closing same-tag nesting) were fixed in **both** seed and CLI on 2026-06-10 — keep them in step. Tracked in `cli/TODO.md`.

## Service conventions (`service/`)

- Zero-dep Node `http`. Don't add npm deps. Static assets read once at startup from `service/public/`; updates require rebuild.
- Landing page (`service/public/landing.html`) has one substitution: `{{SKILL_MD}}`. Service reads from `RWA_SKILL_PATH` (or `service/public/build-skill.md`) at startup and inlines into `<script type="text/markdown" id="skill-md">`, escaping `</script` substrings. Skill content must be self-contained — no references to files that don't ship inline or in the zip.
- `GET /skill.zip` returns STORED-only zip built once at startup from the same `skillBody` plus `service/public/skill/examples/*.html`. Deterministic bytes (`zlib.crc32()` + pinned DOS mtime); `Cache-Control: public, max-age=300` is safe.
- Snapshot publishing (`POST /publish` → `<short>.rewritable.ikangai.com/`): stores `<short>.html` + `<short>.json` in `service/data/` (override via `RWA_DATA_DIR`). Hourly sweep deletes >24h. Substitutes fresh `DOC_UUID` before storing. Rate-limit in-memory per-IP, sliding 1h, leftmost `X-Forwarded-For` behind Traefik. **Each share at its own origin** — 8-char `[0-9a-z]` short codes via `SHORT_HOST_RE`; matching Traefik `HostRegexp` in `service/docker-compose.prod.yml`. Wildcard cert via `letsencrypt-dns` + `auth.acme-dns.io` (DNS-01). Legacy `/s/<short>` paths 301-redirect (path-keyed fallback in local dev where wildcard DNS doesn't resolve).
- Reserved URL prefix `/s/` belongs to publishing — don't reuse.
- **Connected shares** (`/share` route family, apex-only): the stable-URL sibling of `POST /publish` (which stays byte-untouched). `POST /share` mints an update token (`hosted.mintToken`; only the sha-256 capHash at rest in `<short>.json`, `kind:'connected'`); `POST/DELETE /share/<short>` are Bearer-gated. Every publish rotates `DOC_UUID`. All `/share*` responses carry `Access-Control-Allow-Origin: *` + an OPTIONS preflight — the consumer is the seed's ↗ panel at `file://` (null origin); safe because auth is the explicit capability token, never cookies. Two TTL classes share DATA_DIR via `shareExpired()`: ephemeral = 24h on `createdAt` (unchanged), connected = 90d inactivity on `lastActivity` (a GET bumps it). Don't collapse the classes.
- **Hosted-edit runtime** (`/r/` routes in `server.js`; the writable hosted projection) — `/r/` is a NEW reserved URL prefix, disjoint from `/s/`. `/modify` is server-authoritative `rwa-edit/1` apply via `service/lib/*`, which are **vendored byte-identical mirrors of `cli/src`** (cmp-gated by `service/tests/vendored-apply.test.mjs`; re-vendor per `service/lib/VENDORED.md` when `cli/src` changes — same discipline as the CLI's dsl-compiler snapshot). The runtime uses two guarded seed seams (`window.__rwaCommitSink`, `window.__rwaSuppressBlockIds` — additive, byte-identical when unset). `rwa host <file>` is the CLI ingest verb. Full routing + known v1 limitations: see the routing entry above and `docs/plans/2026-06-07-hosted-edit-foundation-*.md`.
- `/import` is the browser-side counterpart to `rwa import`. Conversion happens in the user's browser. Don't move conversion server-side — offline/no-upload is intentional.
- `service/public/import.html` ports `escapeTL`, the INLINE_DOC backtick-walk, TITLE/FILE substitutions (not DOC_UUID — server-side via `/rewritable.html`), `convertCsv`/`looksLikeCsv`, `convertDocx`, `convertPdf`, and `extractParagraphs` from the CLI. **Four sites stay aligned**: `cli/src/seed.mjs`, `cli/src/import.mjs`, `seeds/rewritable.html`, `service/public/import.html`.
- `marked`, `papaparse`, `mammoth` from cdnjs with pinned versions + SRI hashes. **pdf.js is self-hosted** at `service/public/pdf/` — `integrity=` on `<script type="module">` doesn't validate inline imports, so cdnjs has no real SRI protection. Bumping `pdfjs-dist` means re-copying `pdf.min.mjs` + `pdf.worker.min.mjs` from `cli/node_modules/pdfjs-dist/build/`. For cdnjs libs, recompute SRI on bump: `curl -sL <url> | openssl dgst -sha512 -binary | openssl base64 -A`. Don't float versions. Keep aligned with `cli/package.json` resolved versions.
- Mammoth's HTML output doesn't filter URL schemes. Both `cli/src/import.mjs` and `service/public/import.html` post-process through `sanitizeMammothUrls` (allowlist: `http`, `https`, `mailto`, `tel`, relatives, `data:image/*` for `<img src>` only). Keep in sync.
