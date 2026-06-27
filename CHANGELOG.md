# Changelog

Notable changes to `re-write-able`. The container format is versioned in `re-write-able-spec.md`; the edit protocol in `rwa-edit-spec.md`; the structural-transform DSL in `rwa-edit-dsl-spec.md`. The CLI follows semver in `cli/package.json`.

## 2026-06-27 — intelligence/0.2 I-A: recommend a model on activation (cli 0.13.0)

A drop-in intelligence (the carrier shipped in 0.12.0) can now carry a **recommended model**, and the runtime **offers to apply it on activation** behind a one-line consent.

- A non-secret `recommended_model` / `recommended_backend` rides on the `rwa-agent/1` **envelope**, *outside* the signed `agent` — so `canonicalAgent` is unchanged, every existing signature still verifies, and a carrier can add the field **without re-signing**. Seed-only: the CLI / service / oracle are untouched.
- On activation — `runtime.agents.activate(role)`, or the new Activity-panel **Intelligences → Activate** section — the runtime offers to apply it. It is **never auto-applied**, only to `sessionStorage` `rwa_model` / `rwa_backend` (backend enum-validated), and **never** a base-URL override or the API key. The recommendation is a suggestion; the model and key remain sessionStorage-only and never travel in a file.
- New seed surface: `getRecommendation` / `applyRecommendation` / `offerRecommendedModel` / `runtimeActivateAgent`, `runtime.agents.activate`, and an Activity-panel section listing installed intelligences with activate/deactivate (agents had no GUI before).

Pinned by `tests/intelligence-model-rec.mjs` (22/0); regression green (intelligence-drop 15, mode 18, agents 31). Seed-only — shipped via the bundled seed (`rwa new` / `import`); no CLI source change. *Unsigned-envelope design* (not in the signed canon) is deliberate: consent + non-secret + enum-validation make it safe while keeping a deployed signature byte-stable. Forward (spec §6): I-B…I-E. Spec: `docs/specs/rwa-intelligence-spec.md`.

## 2026-06-27 — intelligence/0.2: the drop-in intelligence bridge (cli 0.12.0)

A **droppable intelligence** for rewritables: drag a *carrier* (a `.html` rewritable that carries a signed `rwa-agent/1` role in its frozen `#rwa-agents` zone) onto a target, and the runtime extracts the record, verifies the signature, and routes it to the agent-install consent dialog. The overlay half — an agent *role* that reframes the `⌘K` editor's system prompt and scopes vault access — was already built (v0.9 §12); this is the file-drop bridge that makes it *droppable* (`docs/specs/rwa-intelligence-spec.md` §5).

- **Seed.** `extractAgentEnvelopesFromCarrier` un-escapes the carrier's `INLINE_DOC` and parses its `#rwa-agents` zone exactly as the boot-time trust reader does; `classifyInstallText` / `routeInstallFromText` dispatch a carrier `.html` vs a bare skill/agent envelope; a capture-phase window `drop` claims a dropped carrier (size-capped at 32 MB) before the Edit-mode image drop; the install picker is generalized to accept carriers. **Install stays behind the consent dialog** (the trust anchor) and only for a verified, gate-passing record; activation is separate and never automatic; carriers route only to agents (no skill-code smuggling); the prompt-injection guard is unchanged.
- **Spec + worked example.** `docs/specs/rwa-intelligence-spec.md` re-grounds the design on the built substrate (core v0.15, rwa-edit/1, actions v0.9, self-description) and supersedes the v0.7-citing `intelligence/0.1` draft; `examples/intelligence-carrier/concise-editor.html` is a real signed carrier (jsdom-boot-proven), wired into `tools/regenerate-refs.mjs` as a skill-host reference.

Pinned by `tests/intelligence-drop.mjs` (15/0); regression green (image-assets 92, lens 262, agents 31, skill-install 83, inline-edit 152, mode 18, view 23, chrome 29). Seed-only feature — the npm package ships it because `rwa new` / `import` bundle the seed; no CLI source change. Forward (per the spec §6): the structured model-recommendation channel (I-A) and the §6 design items.

## 2026-06-24 — PDF import: geometry-faithful reconstruction (cli 0.11.0)

`rwa import <file>.pdf` and the browser `/import` page now **reproduce the PDF's layout** instead of flattening it to prose. The previous converter ran pdf.js text extraction and emitted a flat stack of `<p>` paragraphs — so an imported invoice, form, or statement lost every column, table, alignment, and rule and looked nothing like the source.

- **Positioned text, not paragraphs.** Each page is rebuilt as an absolutely-positioned layer at its real point size. Every text run is placed at its true PDF coordinates; adjacent same-style glyphs are grouped into flowing runs, which restores the word spacing a wider substitute font would otherwise eat (the embedded face isn't shipped). Bold/italic are recovered from the embedded font names.
- **Vector rules and boxes.** The page's rules, table grid, and boxes are recovered from a CTM-stack walk of the PDF's operator list — every painted fill/stroke path becomes a positioned element (colors preserved, e.g. a blue link underline).
- **Still a rewritable.** The output is editable real-text DOM — the `⌘K` agent loop rewrites it via find/replace and `rwa doc` reads it. Deterministic and offline, no new dependency; near-perfect, not pixel-exact (system substitute fonts, black text). The scanned/image-only PDF guard is unchanged (exit `2`, no OCR). The model-based `--vision` / `--claude` paths remain for when an exact visual copy is wanted.

Mirrored byte-for-byte across `cli/src/import.mjs` and `service/public/import.html` (verified diff-identical output on a real invoice). CLI 488/488, service 77/77; **no seed change**. Design: `docs/plans/2026-06-24-pdf-import-fidelity-design.md`.

## 2026-06-23 — v0.9 skill layer, part 2: DOM-author skills, worker pool, bus subscribe, marketplace, vault export (cli 0.10.0)

Five more of the v0.9 deferred items, taking the skill layer to **12 of 13** built. All additive, browser- or jsdom-proven (`tests/skill-exec-probe.mjs` Chromium 54/0 + the seed jsdom suites), none lifting the Shape B ceiling. Spec: `docs/specs/re-write-able-actions-spec-v0.9-open-items.md` (items marked ✅ BUILT).

- **I7 — view / edit-surface (DOM-authoring) skills.** New zero-capability kinds: a `view` skill returns HTML (validated — no `<script>`/reserved ids — and applied as a read-only overlay via `runtime.setView(skillId)`); an `edit-surface` skill returns an `rwa-edit/1` envelope, applied through the existing commit path (`runtime.invokeEditSurface` — frozen-zone + structural guards, one ⌘Z). Any declared permission is rejected (`output_skill_with_permissions`).
- **I2 — compute-Worker pool.** Opt-in (`invokeSkill(id, input, {pooling:'enabled'})`), **disabled by default** (the spawn→invoke→terminate path is byte-unchanged). Compute-only, keyed by `skillId+code-hash` (a code change evicts), bounded by `min(4, hardwareConcurrency)` + a 60 s idle sweep, drained on `pagehide`. `runtime.poolStats()`. Per-invocation isolation + the 5 s timeout are unchanged.
- **I1b — bus subscribe.** Completes the bus tier (I1a publish shipped earlier): a skill's `runtime.bus.subscribe(topic, cb)` receives messages on its declared topic during its invoke; an undeclared topic is `bus_topic_denied`.
- **I6 — signed-skill marketplace.** A read-only signed-skill index: the service gains `/skills/{publish,index,revoke,report}` (Ed25519-verified publish, paginated/filterable index, author-signed permanent revocation, rate-limited reports); `rwa skill publish <file>` posts a signed envelope; the runtime can discover, fetch, **verify client-side**, and install via the consent dialog, with TOFU author fingerprints (first-time vs N-installs). Install-time human review stays the trust anchor.
- **I13 — portable vault export/import.** The machine-local vault can export chosen namespaces under a *separate* transport passphrase (a self-contained, version-tagged `rwa-vault-export/1`; PBKDF2-200k + AES-256-GCM) and import them on another machine — fully offline, no account. self-description gains a live-only, opt-in `accountIdentity` (null by default). Account escrow + service deferred to v1.

Also re-vendored `service/lib/{skill-manifest,identity,seed}.mjs` to `cli/src` (the cmp gate caught a `seed.mjs` drift since the 0.8.0 workspace kind). The one remaining v0.9 item, **I9 (Argon2id vault KDF)**, is blocked as specified — the frozen CSP has no `'wasm-unsafe-eval'` — and is staged for a follow-up (vendor hash-wasm's argon2 + a deliberate CSP revision).

## 2026-06-23 — the v0.9 skill layer: tiers, confusables, multi-agent roles, hooks (cli 0.9.0)

The v0.8 skill layer (signed skills, the install-consent trust anchor, every-skill-in-a-Worker, the vault, the runtime-sole-writer frozen zone) shipped earlier; this batch builds eight of the thirteen items v0.8 §11 deferred to v0.9. All are additive, browser-proven (`tests/skill-exec-probe.mjs` — a skill-host generated from the live seed, driven in Chromium, 35/0), and none lifts the "a skill can misuse its *declared* permissions; human install review is the trust anchor" ceiling. The v0.9 contract is `docs/specs/re-write-able-actions-spec-v0.9-open-items.md` (a draft awaiting ratification); items marked **✅ BUILT** there are what shipped.

- **Three new permission tiers** — `bus:<topic>` (publish messages to other rewritables on the machine; I1a), `fsa:<scope>` (scoped OPFS files; I3), `idb:<store>` (a scoped IndexedDB store; I4). Each is grammar-validated at install and gated per-call at the Worker bridge against the skill's declaration; mirrored seed↔CLI. (I1b, skill-side *subscribe*, stays deferred — only useful once Workers are long-lived.)
- **The `hook` kind (I8)** — event-triggered, compute-only automation: a signed skill declaring `hook:on-commit` / `hook:on-open` / `hook:on-mode-change` fires when that lifecycle event happens (fire-and-forget, deterministic order, re-entrancy-guarded, pure-compute Worker with no bridge), and every run is written to a new `rwa_hook_log` audit store (`runtime.hookLog()`). on-commit is the *edit*-commit; on-open is non-blocking so a hook can't slow first paint.
- **Multi-agent roles (I12)** — a skill-host can install signed `rwa-agent/1` records into a second frozen zone (`#rwa-agents`): named roles, each with its own system prompt and a scoped vault-namespace set. `runtime.agents.{list,active,setActive,install,uninstall,message}`; an active role keys `modify()`'s prompt, attributes commits as `agents:<role>`, and narrows the vault bridge to that role's namespaces. The inter-agent bus message shape is data-model only — the request→response choreography is the conductor's job.
- **Confusable-sharpened install anchor (I5)** — a signed Unicode-homoglyph of a *different* author's installed skill (cyrillic `а` for latin `a`) is now hard-blocked (`lookalike_skeleton_blocked`), where ASCII Levenshtein missed it; honest near-misses still only warn. Per-author `name_history` (IDB, reconciled at boot from the in-file manifests) surfaces a same-key rename in the dialog — identity is the key, across name changes.
- **Update re-affirmation (I10) + `rwa install` (I11)** — the install dialog now shows the added/removed permission delta on an update and requires explicit re-affirmation on escalation (no silent permission growth). `rwa install <skill.rwa-skill.json> <host.html> --yes` is the offline, headless counterpart of the dialog: it gates identically (signature verify, `validateInstall`, dynamic-`import()` reject, lookalike warning) and splices the verified envelope into the frozen `#rwa-skills` zone — the CLI is the sole audited exception to runtime-sole-writer.

Still open in v0.9: I1b (subscribe), I2 (worker pool), I6 (signed marketplace), I7 (view/edit-surface skills), I9 (Argon2id vault KDF), I13 (account identity).

## 2026-06-16 — security patch: scheme-validate workspace presence href (cli 0.8.1)

Defense-in-depth follow-up to 0.8.0. The workspace index renders an "Open now" card per peer announced on the public `workspace:presence` runtime-bus topic; `peer.url` is untrusted (any page in the origin can announce presence), and the card placed it in an `href` via HTML-escaping alone — which blocks attribute breakout but not a `javascript:`/`data:` scheme. Not exploitable as shipped (the `sameWorkspaceDirectory()` gate on both the store and render paths requires the URL to resolve into the index's own `file:`/`http(s):` directory, which structurally excludes script schemes), but that left security resting on a subtle invariant in a different function. A new `safeWorkspaceHref()` validates at the sink: it resolves the peer URL and accepts only `http:`/`https:`/`file:`, otherwise falls back to `#`. The CLI workspace generator was already safe (`./` + `encodeURI(filename)`). Pinned by `tests/workspace-presence.mjs` (a newline-laced URL that passes the gate must render a parser-normalized href; no card may emit a script-executing scheme), and verified the regression check fails without the fix. Flagged by automated security review.

## 2026-06-16 — runtime modes, WYSIWYG inline editing, voice; the workspace kind (cli 0.8.0)

Two features land together in the seed (and so in every fresh `rwa new` container).

**Runtime modes + WYSIWYG inline editing.** A rewritable now opens in **Document** mode — the rendered document and any registered view, with *no* editing chrome attached: no click-to-edit, no lens, no anchors, no drag/drop or paste image insertion, no history/palette/skin/model-settings affordances. Editing surfaces live in **Edit** mode (skill-host and workflow containers also expose **Skills**/**Actions** modes). The runtime exposes `runtime.mode` / `runtime.setMode(mode)` / `runtime.on('mode', cb)`; mode switches are in-memory only — they never commit or mutate the document by themselves — and are refused while the modify mutex is held. Document mode stays clean for reading, printing, and sharing; Edit mode is where the work happens.

Inside Edit mode, inline manual edit becomes the primary text gesture: a **single click on a leaf text block** (`p`/`h1`–`h6`/`blockquote`/`li`/`td`) enters in-place editing, with pointer-down opening the surface early enough that the caret lands exactly where you clicked — it behaves like ordinary WYSIWYG page text. (Double-click remains as a compatibility path.) Clicking a non-editable anchorable container — a `figure`, `pre`, `aside`, or table container — still anchors the lens. The dual-mode `/`-prompt discrimination is unchanged: a leading `/` flips the block into prompt mode and runs the instruction through the same block-scoped agent path; Esc demotes to literal text; blur discards without a model call.

**Selection commands + voice.** Selecting text inside one editable block opens a small runtime-only command bar. Type — or dictate, via the browser's speech recognition — `make it bold`, `italic`, or `inline code`; the command compiles locally to `rwa-edit/1` and commits through the non-agent path (`surface:'selection-edit'`, actors `user:selection-command` / `user:voice-selection`). The runtime maps the selected text back to the exact occurrence you selected, so a repeated word targets the right one. Voice is only an input method over the same deterministic parser; an unsupported command fails visibly rather than guessing or implicitly calling a model.

**The `workspace` kind — a folder-level control center.** `rwa new --kind workspace`, or better `rwa workspace create <dir>`, writes a `rwa-index.html`: a workspace-kind rewritable whose editable body holds durable shared context for a directory (workspace memory, guidelines, examples, open questions) and whose frozen `#rwa-workspace` JSON manifest lists the sibling rewritables in that folder. `rwa workspace sync [dir]` refreshes the manifest from the `.html` files on disk while preserving the edited context block. It is deliberately small — it does not merge documents, schedule automations, or expand the skill-host runtime; it gives a folder a portable, editable shared brain plus a truthful machine-readable manifest. When the index is open it also listens on the runtime bus (`workspace:presence` topic) for same-directory rewritables that are currently open, showing them under **Open now**, marked *new since sync* until the next `sync` writes them into the durable manifest. The `self-description/1` contract is mirrored across all four sites (`workspace: []` — a first-party kind with no static affordances).

Normative: `docs/specs/rwa-lens-spec.md` §4.5 (runtime modes) + §5.1 (leaf-click edit, selection commands/voice); `docs/specs/rwa-product-types.md` (the directory-level workspace index). Pinned by `tests/mode.mjs` (18), `tests/inline-edit.mjs` (90), `tests/view.mjs` (23), `tests/workspace-presence.mjs` (5), `cli/tests/workspace.test.mjs` (5), and the full battery (e2e 294, lens 256, image-assets 92, cli 420) + conformance 86/86. References regenerated from the seed.

## 2026-06-11 — atomic.chat backend: a fourth OpenAI-compatible door for the rewrite loop (cli 0.7.0)

**atomic.chat** joins OpenRouter / Ollama / LM Studio as an agent backend — a local OpenAI-compatible inference server (MLX-backed on Apple Silicon) on `http://127.0.0.1:1337/v1`, no key, with real multi-turn `tool_calls`. Pick it in the ⚙ panel (`rwa_base_url_atomic` overrides the base; the Test button lists its models) or drive it from the CLI: `rwa edit notes.html --backend atomic` (`$RWA_ATOMIC_URL` override). Two verified realities are wired in rather than papered over: its CORS allows http(s) page origins but **not `file://`** (the hint says to open the container from a local origin or hosted projection), and it **rejects** requests whose prompt + generation exceed its `MAX_KV_SIZE` (16384) instead of clamping — so the loop now carries a per-backend `max_tokens` (atomic 8192, others unchanged at 32000, `$RWA_MAX_TOKENS` overrides). Live-proven end-to-end: `rwa edit --backend atomic` against gemma-4-26b landed a surgical edit in 8.3 s. Routing is pinned by the new `tests/backends.mjs` — an unwired backend name would silently fall back to OpenRouter, which for a deliberately-local backend is a privacy bug, not a default.

## 2026-06-11 — connected shares: a stable URL a document publishes versions to (spec v0.15, cli 0.6.0)

A rewritable can now be **connected to a stable share URL**. The new ↗ button in the status bar opens a share panel with three gestures, each mapping to exactly one HTTP request: **Create share link** publishes the full current file bytes (exactly the `⌘S` artifact) to `<short>.rewritable.ikangai.com/` and stores `{short, url, token, publishedHash, publishedAt}` machine-locally in `rwa_state`; **Publish this version** re-publishes to the same URL under the Bearer update token; **Stop sharing** deletes it. The panel shows freshness — *"the link shows this version"* vs *"behind your latest edits"* — by comparing the published hash against the current document.

The framing is the feature (`docs/plans/2026-06-11-save-affordance-framings.md` §7c, the local-first analysis this grew from): **the link shows a published version, not live edits.** Working state (IndexedDB, every edit) → checkpoint (`⌘S`, the file) → shared version (↗, the URL): three artifacts, three explicit gestures, every gap visible — replacing the invisible IDB-vs-file gap that made "just email the file" silently share stale bytes. The update token is a capability: only its sha-256 `capHash` is stored server-side, it never reaches the chrome DOM, and it cannot reach the exported file because a commit only rewrites `INLINE_DOC` (both pinned by tests). Every publish rotates `DOC_UUID` server-side, closing the receiver-side inversion this work surfaced: boot hydration is IDB-wins, so a same-UUID re-share would silently show a previous recipient their *stale* local state instead of the update.

Service side: a `/share` route family beside `POST /publish` (byte-untouched): create / Bearer-gated update / delete, CORS on every `/share*` response (the consumer is the seed at `file://`, a null origin; safe because auth is the explicit capability, never cookies), and a two-class sweep — ephemeral publishes keep the 24h `createdAt` rule, connected shares are **durable while active** (90-day inactivity expiry; views and updates both refresh the clock). Share gestures are the only non-agent network the runtime performs; nothing fires at boot or on `⌘S`, so offline-first holds. Distinct from `rwa publish` (ephemeral snapshot, new URL each time) and the hosted runtime (`/r/`, live server-side editing — the canon moves; here it stays in your file).

Pinned by `tests/share.mjs` (36 checks: the three flows, token-leakage pins, freshness flip, failure modes — unreachable keeps the record, 404 clears it loudly) and `service/tests/share.test.mjs` (8 tests: capHash at rest, UUID rotation, auth surface, the two TTL classes through the real startup sweep). Full suite + conformance (86/86) green. Normative contract: `re-write-able-spec.md` §5.11 (v0.15). CLI 0.6.0 ships the new seed — `rwa new` containers carry the ↗ panel.

## 2026-06-10 — embedded images: drag-drop a photo, the file stays single, the model never sees the pixels

Rewritables can now carry images while remaining one self-contained `.html`. Drag an image onto the document (a blue insertion bar tracks the nearest block boundary and the drop position — above or below — by pointer height), paste a screenshot, or type `/image` in the lens for a native picker. The browser ingests deterministically — decode, downscale to ≤1600 px long edge, encode WebP q0.82 (JPEG fallback on older Safari), keep the original bytes when re-encoding doesn't help, retry at 1280 px past the 500 KB per-image budget, and **refuse loudly** beyond that rather than silently degrade. SVG and GIF pass through un-recoded under the same budget. The image lands as a `<figure>` with a data-URI `src` through the same non-agent commit path inline manual edit uses: no model call, instant, one `⌘Z`, attributed `user:image-drop` / `-paste` / `-picker`. Hovering an image shows a one-click ✕ (`user:image-delete`); clicking it anchors the lens, so `/make this smaller` or `/add a caption` run as ordinary anchored commands. A container-size guard warns at 5 MB and refuses inserts at 10 MB.

The bytes live in the document itself — `⌘S`, undo, history and import/export all carry real pixels, and the single-file invariant holds *by construction* (no sidecar store, no hydration, nothing to evict). What changed is the **model's view**: at every agent boundary — `⌘K`, the bridge backend, anchored commands, and `rwa edit` alike — each `data:image` URI is swapped for a compact `rwa-asset:<hash8>` token, and the apply core expands tokens back after validation. The size caps (`MAX_REPLACE`, `MAX_DOC`) are measured on the token form: a text budget, never a pixel budget. An invented token rejects as `unknown_asset_reference` with the same structured retry feedback as every other failure code, and a writer that supplies no asset bytes cannot mint a new token — a broken image never commits silently. Hosted-runtime note: the commit sink hands the server the *expanded* envelope; image-bearing edits through the hosted projection remain a known v1 limitation (the server's 8 KB per-edit cap).

Pinned by `tests/image-assets.mjs` (83 checks: round-trip identity, agent boundaries, compose/skin interplay, GUI surfaces) and `cli/tests/image-assets.test.mjs` (including an end-to-end proof that a 200 KB image doc prompts at under 20 KB with zero `data:image` bytes); real-browser-proven on `file://` Chrome — a 2.1 MB 4000×3000 JPEG ingests to a 206 KB 1600×1200 WebP, undoes, and persists across reload. Normative contract: `rwa-edit-spec.md` §19 (v1.6); insert surfaces: `docs/specs/rwa-lens-spec.md` §6.3 (v0.11). Design: [`docs/plans/2026-06-10-images-in-rewritables-design.md`](docs/plans/2026-06-10-images-in-rewritables-design.md).

## 2026-06-08 — inline manual edit: edit a block by hand, no model

Double-click any leaf text block — `p`, `h1`–`h6`, `blockquote`, `li`, `td` — and edit its text directly in the page: `Enter` commits, `Shift+Enter` inserts a line break, `Esc` reverts, blurring commits, emptying the block deletes it. **No model call, no API key** — the offline counterpart to the lens. Single-click still anchors the lens, unchanged; the two coexist on the same blocks by click count.

It is a new direct-manipulation **edit-surface** (history actor `user:edit-surface`), not a lens mode: it rides the existing non-agent commit path (`runtimeApplyEnvelope` → `commitCore`, the R5 write path), so a hand-edit is one `⌘Z` frame and passes through the same frozen-zone, structural-shape and reserved-marker guards as every other edit. No new apply/validator/commit machinery — the whole feature lives in how the replacement is synthesized.

That synthesis (`serializeLeafSafe` + a verbatim re-emit of the block's original opening tag, in `seeds/rewritable.html`) closes two corruption modes a naive `contenteditable` hits: dropping the block's `data-rwa-id` (which would silently break every `#id` fragment link to it) and letting browser-left `<div>`/`<br>` soup reach storage (which reparses on the next render and desyncs the anchor map, so later clicks target the wrong block). A no-op edit commits nothing; a delete that would change the document's structural shape is surfaced, not silently dropped. Frozen zones (`data-rwa-frozen` + marker form) and `.rwa-locked` subtrees are not editable; the handler is inert under an active view. `figcaption` is deliberately out of v1 (it is not independently anchorable — it lives inside `<figure>`).

Pinned by `tests/inline-edit.mjs` (40/40) + an inertness check in `tests/view.mjs`; full suite + conformance (86/86) green. Design: [`docs/plans/2026-06-08-inline-manual-edit-design.md`](docs/plans/2026-06-08-inline-manual-edit-design.md). Spec boundary note in `docs/specs/rwa-lens-spec.md` §5.1.

## 2026-06-07 — universal surfaces: clone, publish-site, operations-API, Telegram, phone

A cluster of surface adapters landed on the same day as the hosted-edit foundation (below), all of them new *doors* onto the existing rewritable operations rather than new implementations. The keystone is a spec that names the contract; the rest are thin adapters that route to it.

### operations-API contract (`docs/specs/rwa-operations-api.md`, v0.1 draft)

Names the five operations every rewritable surface speaks — `bootstrap / import / modify / describe / publish` — and fixes the three load-bearing wire strings they share (`rwa-edit/1`, `rwa-edit-dsl/1`, `self-description/1`), baked verbatim in `seeds/rewritable.html` and mirrored in the CLI. A routing index, not a re-statement: it maps operations × surfaces (CLI, in-file lens, service, hosted runtime, skill) to the spec that owns each, so adding a surface collapses from "build a product" to "write a thin adapter." This is the keystone that frames clone / publish-site / Telegram / phone — and the hosted runtime below — as adapters onto one contract. North-star framing: [`docs/plans/2026-06-04-north-star-universal-surfaces.md`](docs/plans/2026-06-04-north-star-universal-surfaces.md).

### `rwa clone <url>` — webpage → rewritable

The network-bearing sibling of `rwa import` (`cli/src/clone.mjs`): fetch a public webpage, extract its main article + title (parser-free), run it through the same `sanitizeImportedHtml` the import path uses, and bake the content into a fresh container with a provenance footer. **Content-only in v1** — the source page's styles are not cloned; the doc renders with the seed's baseline typography. The fetch is **SSRF-guarded** (`http`/`https` only; private/loopback/link-local/metadata addresses blocked, including via DNS rebinding and per-hop redirect re-validation; size-capped; HTML-only). A blocked/failed fetch exits `2` (`file_error`: `blocked_host`, `bad_scheme`, `not_html`, `http_error`) and writes no file; an existing destination exits `2` (`exists`) unless `--force`.

### `rwa publish-site <file>` — durable scp publish

The durable counterpart to `rwa publish`'s ephemeral 24h share (`cli/src/publish-site.mjs`): copy a self-contained rewritable **verbatim** onto a static site over scp and print the live URL — same bytes, your own host, no expiry. **Flags-over-env config** (`RWA_SITE_HOST` / `RWA_SITE_PATH` / `RWA_SITE_URL`, each overridable by `--host` / `--path` / `--url`; nothing baked into the package). Transport is `execFile('scp', [argsArray])` (never a shell string; `--` guards leading-dash paths; absolute local source so scp never mis-reads an embedded `:`). Remote name is `basename` + allowlist (`SAFE_NAME`), closing path-traversal and shell-token injection at one gate. The failure surface mirrors `publish.mjs`: `file_error` (exit 2), `config_error`/`invalid_name` (exit 1), transport (exit 4, labeled `publish_error`). Design: [`docs/plans/2026-06-06-ikangai-custom-publish-design.md`](docs/plans/2026-06-06-ikangai-custom-publish-design.md).

### Telegram bot (`surfaces/telegram/`)

A long-poll Telegram bot that is a **thin adapter over the `rwa` CLI** — no webhook, no rewritable logic of its own, all subprocess calls through `execFile(cmd, [argsArray])` (no shell, ever).

- **Phase A — create & publish.** Send text / a markdown file / a document → it wraps the content into a self-contained page and replies with a shareable link (ephemeral 24h). `/new <prompt>` agent-fills via `rwa create` (gated on a model backend). Hardened: flag-smuggling defense (dash-leading prompts rejected, dash-leading paths neutralized), a 20 MB document cap, per-chat rate limit, no secret leakage. Design: [`docs/plans/2026-06-07-telegram-phase-a-design.md`](docs/plans/2026-06-07-telegram-phase-a-design.md).
- **Phase B — in-chat editing of hosted rewritables**, gated on **`RWA_FOUNDATION_URL`** (unset ⇒ exactly Phase A; the foundation client is never even constructed). One active hosted doc per chat: `/new` creates and binds an editable doc; a plain message becomes an edit instruction against it; `/show` and `/export` (the canonical `.html`, the offline escape hatch). Capability tokens stored `0600`, never logged. Design: [`docs/plans/2026-06-07-telegram-phase-b-design.md`](docs/plans/2026-06-07-telegram-phase-b-design.md). Tests are fully offline (injected Telegram transport + `execFile`).

### Phone voice spike (`surfaces/phone/`)

A **timeboxed spike** — call a number and **talk to one bound hosted rewritable**: ask it questions or speak a change and have it edited, over Twilio voice (`<Gather input="speech">` / `<Say>`). One webhook POST = one turn; `handleTurn` classifies *ask vs edit* (model judgment, `ask` is the read-only default), then either answers from the doc or runs export → `rwa edit` → `modify` against the hosted-edit foundation (409 `stale_base` retries once). A call never ends in silence. Reuses the telegram surface's foundation client + Phase B `rwaEdit`. **Gated on Twilio creds + a public URL.** Known-deliberate cut: the webhook is **unauthenticated and write-capable** — anyone who knows the URL can POST and edit the bound doc, so **bind only a throwaway/demo doc**; HMAC-validating `X-Twilio-Signature` is the production follow-up. Untrusted text is XML-escaped before TwiML; the body cap is 64 KB. Design: [`docs/plans/2026-06-07-phone-spike-design.md`](docs/plans/2026-06-07-phone-spike-design.md). Pure core unit-tested offline; the http server is read-reviewed.

## 2026-06-07 — hosted-edit foundation: writable hosted runtime (`/r/`)

A writable hosted runtime in `service/` that stores a rewritable's canonical bytes and exposes the operations contract over HTTP, so a rewritable can be edited *from a distance* — a chat, a phone, the web — without dethroning the file. The bytes the server stores ARE a rewritable; `GET /r/:id/export` always returns the real `.html`, byte-for-byte what `⌘S` would write. Hosting adds a remote door onto *modify*; it does not create a second source of truth. This is the foundation under every remote-*edit* surface (Telegram Phase B, the phone spike).

Design + build: [`docs/plans/2026-06-07-hosted-edit-foundation-design.md`](docs/plans/2026-06-07-hosted-edit-foundation-design.md) (architecture + the capability-token auth decision), [`…-build-design.md`](docs/plans/2026-06-07-hosted-edit-foundation-build-design.md) (resolved decisions + the seed seams), [`…-build-plan.md`](docs/plans/2026-06-07-hosted-edit-foundation-build-plan.md) (the 8-task TDD plan). Built subagent-driven with a two-stage (spec + code-quality) review gate per task.

### The HTTP surface (`/r/`, a new reserved prefix disjoint from `/s/`)

- `POST /r` — ingest a rewritable → `{id, token, url}`; mints a per-rwa capability token.
- `GET /r/:id` — a live editable browser projection: the real container plus a prepended shim that redirects the seed's commit to the server.
- `POST /r/:id/modify` — apply an `rwa-edit/1` envelope server-side → `{doc, baseHash, selfDescription, histLen, undoLen}`. Optimistic concurrency via `baseHash` (`409 stale_base`); apply failures → `422 {error:<subcode>}` (the same vocabulary as `rwa edit --json`).
- `GET /r/:id/{describe,doc,export}` — `self-description/1`, the editable body + its `baseHash`, and the canonical bytes. Plus `POST /r/:id/{undo,rotate}` and `DELETE /r/:id`.
- CLI: `rwa host <file>` ingests a local rewritable into a hosted runtime.

### How the projection works — two guarded seed seams

The seed's commit path is closure-private (the lens calls the internal `modify()`; `RWA` is a closure const), so an injected script can't redirect it. Two small additive seams in `seeds/rewritable.html`, each byte-identical when its `window.*` flag is unset — so every existing file:// / share / CLI container is untouched (pinned by `tests/commit-sink.mjs` and `tests/hosted-bless-parity.mjs`):

- `window.__rwaCommitSink` — at `commitDoc` (the single shared write funnel): when set, the validated `rwa-edit/1` envelope is handed to the sink (which POSTs to the server) instead of the local IDB commit; the server's returned doc is mirrored locally and rendered. The server is the authoritative apply path.
- `window.__rwaSuppressBlockIds` — at boot: suppresses the boot-time `data-rwa-id` blessing in hosted mode, so the hosted body stays un-blessed and the client's `baseHash` matches the server's. A real-browser end-to-end caught a false-`409` on every hosted edit because the boot blessing wrote random ids into the hashed doc; the second seam is the fix, and it also keeps `data-rwa-id` out of the agent's envelopes.

The agent still runs client-side (the user's own key); the service is model-free and only ever applies validated envelopes — a single audited write path. The apply path itself is the CLI's pipeline, vendored byte-identical into `service/lib/` (cmp-gated by `service/tests/vendored-apply.test.mjs`), since the deploy ships `service/` only.

### Auth, concurrency, lifecycle

Capability-token-only, no accounts: 32-byte tokens, sha-256-hashed at rest, constant-time compared, never logged, delivered via the URL `#k=` fragment. Per-id write lock + `baseHash` precondition (no lost updates). Persist-until-`DELETE` with a 90-day inactivity sweep; per-token rate limit; a server-side `MAX_DOC` cap. Undo is a server-side pre-image stack (`POST /undo`), crash-safe — it never reconstructs bytes from the forward `history.jsonl` audit log.

### Verification

Offline: `service/tests` 61, CLI 351, conformance 86 (incl. `HOST-01` — hosted apply byte-identical to the substrate apply), the two seed-seam tests, the vendored cmp gate, and a real-browser end-to-end (create → edit → undo → reload-sync). A holistic pre-merge review found zero critical issues.

### Not yet deployed — deploy gate

The runtime is built and verified offline but **not deployed**. Going live requires a host, DNS, and a writable `data/` volume — and, as a security requirement, serving `/r/:id` **per-subdomain** (the same pattern `/s/` shares use: a Traefik `HostRegexp` router + the wildcard cert) so each hosted doc's `sessionStorage`/IDB is origin-isolated. The apex path-keyed form has a narrow cross-doc capability-token-exposure risk and must not be exposed to untrusted ingest at scale.

## 2026-05-25 — Import-flow security release (CLI 0.3.1)

Hardening of the markdown / docx / csv / pdf import path on both surfaces — the `/import` browser endpoint (`service/public/import.html`) and the `rwa import` CLI (`cli/src/import.mjs`, `cli/src/seed.mjs`). Driven end-to-end by autoresearch: a 50-scenario UX stress-test (`scenario/260522-1427-import-stress-ux/`) catalogued 4 critical + 8 high + 24 medium + 14 low findings, a 15-iteration debug pass (`debug/260523-0739-import-html-bugs/`) verified 9 of them with code-level evidence, and this release lands the 7 surgical fixes. The 8th finding (no Content-Security-Policy) is deferred to a spec-level discussion. All fixes apply identically to browser and CLI per CLAUDE.md's four-sites alignment rule.

### Critical

- **Markdown XSS** (`c7d0cc2`) — `marked` does not sanitize HTML, per its own README ("🚨 Marked does not sanitize the output HTML"). The seed bootstrap at `seeds/rewritable.html:849` injects INLINE_DOC via `m.innerHTML` AND lines 850-855 explicitly re-create `<script>` tags so they execute (intentional for documents that ship JS, but it meant an imported `.md` with `<script>alert(1)</script>` was a turn-key payload). New `sanitizeImportedHtml` strips active-content tags (`script`, `iframe`, `object`, `embed`, `svg`, `math`, `link`, `meta`, `base`), drops `on*=` event-handler attributes, and runs URL allow-listing on surviving `href`/`src`. Verified against 11 markdown XSS payloads.
- **Sanitizer scheme-detection bypass** (`fcf42a1`) — the regex `/^\s*([a-z]+):/i` in `_attrIsSafe` missed inputs the WHATWG URL parser still resolved as `javascript:`. Six bypass variants confirmed: zero-width space (U+200B), soft hyphen (U+00AD), right-to-left override (U+202E), control-char prefix (U+0001), BOM (U+FEFF), and newline-in-scheme (`java\nscript:`). The last two were unambiguous exploits — the WHATWG URL parser strips newlines and controls before scheme detection, so they round-tripped to actual `javascript:` URLs. Replaced with a two-layer check: an invisibles-stripping normaliser (`_ATTR_STRIP_RE`) covering whitespace + C0/C1 controls + Cf-class format chars, followed by `new URL(normalised, syntheticBase)` parsing — the same parser the browser uses to navigate. Verified against 23 URL inputs.

### Medium

- **Filename `</script>` injection** (`18521c7`) — `escapeJsString` only escaped `\` and `'`, not `</script` like its sibling `escapeTL` does. A filename like `evil</script><svg onload=alert(1)>.md` (Linux + macOS both allow `<`/`>` in filenames) closed the bootstrap `<script>` tag early via the `FILE:` substitution and turned subsequent text into HTML. The CLI is more exploitable here than the browser because `rwa import <path>` accepts arbitrary strings; the browser is hard to exploit but produces an equally dangerous container. Now matches `escapeTL`'s handling.

### High

- **Status `<p>` not announced to screen readers** (`4a98bd0`, WCAG 4.1.3) — added `role="status"` to `<p id="status">` so the conversion progress + error states reach assistive technology. The drop zone already had `role="button"` and the share div had `aria-live="polite"`; the status element was the gap. One-attribute change.
- **`.busy` was cosmetic only** (`8c8568e`) — the drop zone's `.busy` class set only `opacity` and `cursor`; pointer events remained active, so a second drop during an in-flight conversion clobbered `lastShare` and could trigger a double download (or publish the wrong content if the user clicked Publish during the race). Added `pointer-events: none`.

### Low

- **`renderShareSuccess` crashed on invalid `expiresAt`** (`346e164`) — `new Date(undefined).toISOString()` throws RangeError, leaving the share UI stuck on "Publishing…" as an unhandled promise rejection. Wrapped in try/catch with a fallback "Expires within 24 hours" hint.
- **Browser `convertCsv` silently dropped Papa errors** (`80fd2e4`) — comment claimed errors became warnings "matching the CLI's behavior"; code returned `warnings: []` unconditionally. Now mirrors the CLI: each `result.errors` entry surfaces as a `csv parse: …` warning, which `handleFile` already routes through `console.warn` and the user-visible "(N notes — see console)" status suffix.

### Verification

Two repro/coverage harnesses ship alongside the fixes — currently at `/tmp/verify-c1-md-sanitizer.mjs` and `/tmp/verify-c2-from-files.mjs`; promotion to `cli/tests/import-security.test.mjs` is the recommended follow-up. 34 combined cases pass: 11 markdown XSS payloads (script tag, `<img onerror>`, `<svg onload>`, `<iframe srcdoc>`, markdown link with `javascript:` href, inline anchor with `vbscript:`, `<details ontoggle>`, ZWSP-prefixed `javascript:`, `<base>`, plus negatives confirming safe `https` links and inline code with literal `<script>` text are preserved) and 23 URL inputs (5 classic schemes + all 6 bypass variants from the debug report + space/scheme edge cases + 4 src-attribute cases including the SVG-as-img case that passes the allow-list but is still safe because of the browser's image-loading sandbox).

### Deferred

**No Content-Security-Policy** on the seed or service responses — architectural. The rwa container model is "inline `<script>` is the app", so any CSP needs `script-src 'unsafe-inline'`. A partial CSP whitelisting only `connect-src` (the known agent endpoints: OpenRouter, Ollama, LMStudio) would still meaningfully reduce post-injection exfiltration without breaking the model. Tracked for a spec-level discussion before code.

## 2026-05-22 — print CSS fixes for long strings + nested blockquote

Three fixes to the `@media print` block in `seeds/rewritable.html`, found by adding the visual scenarios listed in the next entry (`edge-04` through `edge-08`) and reading the rendered PDFs. Each fix addresses a real failure mode rather than a hypothetical concern:

- **`<pre>` no longer clips long lines on print.** The baseline `pre { overflow-x: auto }` scrolls horizontally on screen, but on paper there is no scrollbar — long lines were truncated at the right margin and the user lost data. Print override now sets `white-space: pre-wrap; overflow: visible; overflow-wrap: anywhere`, wrapping long curl commands, JSON bodies, and stack traces at sensible points. Verified: a 200-char Authorization header that was previously clipped after ~80 chars now wraps and remains fully readable.
- **Long unbroken strings in body text break instead of overflowing.** `p, li, td, th, code, a` get `overflow-wrap: break-word` on print — gentle breaking that preserves column widths in narrow tables (the stronger `anywhere` setting was tried first but fragmented short words like "Step" into "St / ep" in narrow table columns, so reverted to `break-word` for non-`pre` selectors). Catches long hashes, German compound words, file paths, and bare-text URLs.
- **`<blockquote>` removed from the `break-inside: avoid` set.** A blockquote is a flowable container (often holds paragraphs, lists, even tables), and forcing it intact created the "sparse page 1" anti-pattern — page 1 with just an H1 + intro, then the entire blockquote on page 2. Inner paragraphs retain `orphans/widows: 3` protection so a blockquote split is still readable. Verified on `edge-07` (table-in-list-in-blockquote): page 1 now fills with content, only the trailing summary sentence flows to page 2.

5 new visual scenarios added to verify the fixes (`edge-04` long URL, `edge-05` long pre line, `edge-06` long hash / German word, `edge-07` deeply nested, `edge-08` rich table cells). All 28 print scenarios pass on the patched runtime. References (`hello.html`, `re-write-able-spec.html`) regenerated to mirror the seed.

What remains a known limit: when a single block exceeds one printed page (table > 1 page, very large figure), the engine still moves the whole block to a fresh page before accepting an internal break. `tbl-02` and `edge-03` document this; the only fix is authoring guidance ("split long tables manually") since CSS cannot tell the engine "use the trailing space on this page before moving".

## 2026-05-21 — print-fidelity test scenarios (23 fixtures + validator)

Closes a gap in the benchmark coverage: the `@media print` stylesheet in `seeds/rewritable.html` has been quietly load-bearing for save-as-PDF since the seed shipped, but had no test surface beyond manual eyeballing. The existing `pres-13` / `pres-14` / `pres-15` scenarios cover *edit fidelity* (does the agent preserve print CSS during edits?), not *visual fidelity* (does the rendered PDF actually look right?). This release adds the latter.

### What ships

`benchmark/scenarios/print/` — 23 self-contained HTML fixtures across 9 categories:

- **sp** (3) — single-page docs: placeholder-only, short prose (full-width on print, not the 720px screen card), receipt with intact table
- **mp** (2) — multipage prose: long form with no orphan/widow stranding; H2 near page break stays with its following paragraph
- **tbl** (5) — small intact, 25-row across pages (every row on exactly one page), tall row moves as a unit, wide 9-column without overflow, caption + table together
- **code** (2) — short `<pre>` intact; 120-line dump documents the engine-forced-break limit
- **list** (2) — 50-item bullet list breaks between items only; 12 multi-line items stay intact
- **fig** (2) — figure + caption stay together; figure near boundary moves cleanly
- **chr** (1) — `#rwa-runtime`, lens placeholder, and `.placeholder` all hidden in print output
- **pg** (3) — default 18mm margin, document-level `@page` override wins, named-page cover + body with `@top-center` header and `counter(page)` footer
- **edge** (3) — forced `break-before:page`, `print-color-adjust:exact` preserves coloured backgrounds and forces link text black, oversize blockquote breaks inside at clean line boundaries

Each fixture is a real `.html` you can open in any browser and verify by ⌘P preview against the embedded checklist. The print CSS is mirrored from the seed verbatim (drift-controlled via `generate.mjs`), so what each fixture exercises matches what the runtime ships.

### Runner

`benchmark/scenarios/print/validate.mjs` prints every fixture to PDF via headless Chrome, then runs text-only assertions on the result: page-count exact / minimum / maximum, text presence / absence, "every row on exactly one page", "caption + table on same page", "forced-break target page". 23 / 23 pass on the current runtime. Output PDFs land in `benchmark/results/print/<id>.pdf` — same basename as the source fixture in `scenarios/print/<id>.html`, so source and rendered output sit side-by-side for visual review or cross-run diffing. Both the validator output dir and the PDFs are gitignored.

Requires Chrome / Chromium on PATH or the default macOS location, and `pdfinfo` / `pdftotext` from `poppler` (`brew install poppler`). Skips gracefully when either is missing.

### What's deliberately NOT included

- No puppeteer dependency — the validator shells out to the local Chrome binary, keeping `benchmark/package.json` at its current jsdom + fake-indexeddb minimum. The longer-term puppeteer-based design lives in `scenarios/print/_runner-spec.md` for when pixel-level assertions become worth the dep cost.
- No screenshot diffing — pixel diffs on rendered PDFs are flaky (subpixel rendering, colour profile, paper rounding). The assertion vocabulary is intentionally semantic.
- No coverage of Safari / Firefox print engines — fixtures still print correctly in both, but the named-page header/footer scenario (`pg-03`) is the most engine-sensitive and is documented as such.

## 2026-05-20 — gemini-3.5-flash default, lens progress chip, 9 new fidelity scenarios

Three small things landed together: a model bump for OpenRouter users, an inline progress affordance on the lens, and nine new fidelity scenarios that raise the complexity bar on tables, semantic header/footer, and print stylesheets.

### Default model: `google/gemini-3.5-flash`

`RWA.MODEL` (the OpenRouter default for fresh containers and the `rwa edit` instruction path) is now `google/gemini-3.5-flash`, replacing `google/gemini-3-flash-preview`. Mirrored across the seed, `cli/bin/rwa.mjs`, `cli/src/import-vision.mjs`, and the help / `cli/README.md` / `service/public/build-skill.md` documentation. Existing containers are unaffected — the model is per-container `sessionStorage` (`rwa_model`), so a user who picked a model previously keeps that pick.

The settings panel's model `<input>` is now pre-populated with a curated `<datalist>` of seven benchmarked OpenRouter model ids — `google/gemini-3.5-flash`, the previous `gemini-3-flash-preview`, the two `gemini-3.1-*` previews, and the three frontier-Anthropic ids that show up in `benchmark/results/`. So when a new user opens ⚙ for the first time, typing into the model field gets real autocomplete out of the box. Local backends (Ollama / LM Studio) still populate the datalist live from `/v1/models` when the Test button is clicked.

### Lens progress chip

The lens textarea now shows an inline animated progress chip above the input while the agent is working — mirroring the affordance pattern from Claude's app. Four states, all centralized through a new `setLensProgress(state, msg)` helper:

- `thinking` — italic grey text with a spinning ring; shows `Thinking…` initially, switches to `Applying edits…` / `Applying structural plan…` / `Applying full rewrite…` once the tool call comes back, and `Retrying (attempt N/3)…` between retries.
- `done` — green `✓ Done`, auto-clears after 1.4s so it doesn't linger past the re-render.
- `error` — red `✗ <code>` that sticks until the next modify call overwrites it. Surfaces the structured failure code from `rwa-edit/1` (`find_not_unique`, `frozen_zone_violation`, …) inline rather than just in the corner status pill.
- `bridge` — `Asking claude -p…` while the localhost bridge subprocess cold-starts.

Wired into all three agent code paths in `seeds/rewritable.html` — `modify()` (default-command + `runtime.modify` from in-document JS), `runAnchoredCommand()` (anchored slash commands), and `modifyViaBridge()` (the claude-p bridge). The previous `data-busy` pulse-dot was only set by one of those three paths; consolidating the affordance fixed an unintentional silence on the default-command path.

### 9 new fidelity scenarios: tables, headers, footers, print

`benchmark/scenarios/fidelity/pres-07.mjs` through `pres-15.mjs` add complexity coverage in three clusters:

- **Tables** — invoice-table line-amount edit with subtotal/VAT/total recompute (PRES-07; math-consistency oracle checks sum-of-lines == subtotal and subtotal × 1.19 ≈ total), `rowspan`/`colspan` survival under a regular-cell edit (PRES-08), adding a new column to thead + tbody + tfoot with column-count parity (PRES-09), and table-within-table with the inner table byte-identical under an outer-cell edit (PRES-10).
- **Headers and footers** — edit article body with semantic `<header>` + `<footer>` (logo, nav, tagline, secondary nav) byte-identical (PRES-11), and surgical copyright-year update in `<footer>` with aria-label, license rel-link, mailto and address all preserved (PRES-12).
- **Print stylesheets** — `@media print` block with break-control + orphans/widows + `print-color-adjust` rules byte-identical across a prose edit (PRES-13), surgical `@page { size: A4 → Letter }` swap with margin shorthand and `@page :first` override preserved (PRES-14), and a stacked report combining `@page` running header + `@media print` rules + masthead + multi-section article + semantic footer where one deep paragraph in section 2 is the only thing that changes (PRES-15).

Stub-fidelity suite goes from 89 → 98 scenarios, all scoring 2/2 (S=2 success, T=2 stability). Aggregate stays at `meanS=2.00 meanT=2.00 median_drift=0.0000`. 62/62 conformance unchanged; 291/291 e2e + 246/246 lens still pass.

## 2026-05-19 — `rwa edit`: programmatic edit CLI

A new `rwa edit <file>` verb lets skills, CI jobs, and scripts apply `rwa-edit/1` envelopes to a rewritable file from outside the browser. Same edit grammar as ⌘K: frozen-zone enforcement, reserved-substring detection, structural-shape check, atomic write. Three invocation forms — positional instruction (runs the agent loop), piped envelope on stdin, or `--plan <file>` from disk — all converge on the same `applyPlan` splice/write path.

Design: [`docs/plans/2026-05-19-rwa-edit-cli-design.md`](docs/plans/2026-05-19-rwa-edit-cli-design.md). Implementation plan: [`docs/plans/2026-05-19-rwa-edit-cli-plan.md`](docs/plans/2026-05-19-rwa-edit-cli-plan.md). Per-task review verdicts and follow-ups are tracked in [`cli/TODO.md`](cli/TODO.md).

### What ships in v1

- **Plan path** (deterministic): pipe an `apply_edits`, `apply_dsl_plan`, or `replace_document` envelope; the CLI validates shape + version + per-shape required fields, runs it through the same DSL compile + apply pipeline the browser uses, and writes the file atomically (temp + `datasync` + `rename`). No API key required. Frozen-zone preservation and reserved-substring guards are enforced exactly as in the browser; `replace_document` envelopes additionally must preserve every marker-form frozen zone byte-identically.
- **Instruction path** (agent-driven): a positional instruction string triggers a multi-turn tool-use loop against an OpenAI-compatible backend. Same retry budget (3), same system prompt + tool schemas as the browser — extracted at runtime from the bundled seed via three `// rwa:extract:begin/end <NAME>` marker pairs added to `seeds/rewritable.html`. Backends: `openrouter` (default, requires `RWA_OPENROUTER_KEY` or `--api-key`), `ollama`, `lmstudio`. The browser-only `bridge` transport is intentionally excluded — invoke `claude` directly from the CLI if you need that path.
- **Stable exit codes**: `0` success, `1` usage_error, `2` file_error, `3` envelope_error, `4` agent_error. Each carries a `subcode` — `find_not_unique`, `frozen_zone_violation`, `version_mismatch`, `missing_reason`, `no_envelope_after_retries`, `no_api_key`, etc. `--json` flag emits one structured object per line on stderr (`{code, subcode, details}` plus `{phase:"retry", attempt, reason}` during agent retries) for skills and CI.
- **Atomic write**: `<file>.rwa-tmp-<pid>` + `FileHandle.datasync()` + `rename` so a crash mid-write can't corrupt the rewritable. The exported `.html` on disk remains the only durable artifact — the CLI must not be able to corrupt it.

### Skill consumption pattern

The plan path is the building block for skills that maintain rewritable artifacts. A skill composes an `apply_dsl_plan` envelope in code:

```js
const plan = {
  version: 'rwa-edit-dsl/1',
  ops: [{ op: 'insert', before: '<!-- diary:entries:end -->', content: '<section data-rwa-date="...">...</section>' }]
};
const child = spawn('rwa', ['edit', '.dev-diary/diary.html'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.write(JSON.stringify(plan)); child.stdin.end();
```

and pipes it to `rwa edit`. Deterministic, no model call, no API key — the skill knows the entry structure so it never needs to invoke the agent for routine appends. The full consumption pattern (including first-time creation via `rwa new` + `replace_document` envelope) is in the design doc.

### Spec → CLI alignment, with explicit scope-downs

The CLI mirrors the seed's edit grammar deliberately, with each divergence documented inline:

- **DSL compiler** is a publish-time snapshot of `benchmark/oracles/dsl-compiler.mjs`. The `prepublishOnly` script runs `cmp` against the canonical source *before* the `cp` so developer-introduced drift fails the publish loudly. Adds a fourth aligned site to the existing three (spec / runtime / benchmark) — the trade is intentional, called out in CLAUDE.md's "CLI conventions" section.
- **Apply pipeline** (`apply-edits`, frozen-zone, reserved-substring, structural-shape) is hand-mirrored in `cli/src/apply-edits.mjs`. The header comment enumerates v1 parity gaps vs. the seed: no `MAX_REPLACE`/`MAX_DOC` byte caps, no `canonLF` line-ending normalization, no class-lock checks, no `parse_error_post_apply`, no `data-rwa-id` injection guard, no attribute-form `data-rwa-frozen` enforcement (a `test.todo` documents the gap). Marker-form frozen zones, reserved-substring detection, and the structural-shape regex (script/style top-level tag counts) all match the seed. Tracked for v2 in [`cli/TODO.md`](cli/TODO.md).
- **Agent loop** (`cli/src/agent-loop.mjs`) retries on `no_tool_call` (model emitted plain text) and `invalid_json` (tool arguments aren't parseable) — three attempts, then `no_envelope_after_retries`. Apply-time failures surface as `envelope_error` exit 3 with no retry; this diverges from the seed runtime, which feeds apply failures back as `tool_result` and lets the model recover. Bringing apply-time feedback to the CLI is tracked as v2 work.
- **User message + request body** match the seed's `buildUserPrompt` shape: `User request:\n<inst>\n\nFrozen zones in the current doc: <names or (none)>\n\n<DOC>\n<doc>\n</DOC>`. Request body sends `max_tokens: 32000` and `tool_choice: 'auto'`.

### Tests

72 new tests (plus 1 documented `test.todo` for the attribute-form gap) under `cli/tests/`, covering the apply pipeline, envelope validation, CLI dispatch, agent loop with retries, mock-backend instruction-path E2E, and atomic-write behavior. A bundled `cli/tests/helpers/mock-backend.mjs` exercises the full agent loop against an in-process OpenAI-compatible HTTP server — no network, no API keys required for CI. All 246 lens + 291 e2e + 62 conformance scenarios remain green; the seed edit (adding the three extract-marker pairs) is non-behavioral and tested by the existing runtime harness.

## 2026-05-18 — blank doc redesign + baseline content typography + print stylesheet

Fresh containers now open as a clean "Untitled" document rather than a centered hello-world splash, and `seeds/rewritable.html` ships a baseline content stylesheet plus a full `@media print` rule set that every document inherits for free.

### Empty document

A new container's `INLINE_DOC` is a minimal `<article>` with an `<h1>Untitled</h1>` and an italic, low-contrast placeholder paragraph ("Start writing, or ask the lens below to draft something for you."). The placeholder is `.placeholder`-classed and hidden under `@media print`, so an unwritten doc prints as a clean page with just the heading at the top — no instructional copy bleed-through. Replaces the previous Georgia-italic full-viewport hello splash, which printed as a half-empty centered headline and didn't read as "this is a document".

### Baseline content stylesheet

The seed bootstrap now styles `:where(#rwa-doc-mount) article, h1…h6, p, ul/ol, blockquote, pre, code, hr, table, img, figure, kbd` with a clean system-font default. Wrapped in `:where()` so specificity is 0 — any `<style>` block inside an `INLINE_DOC` (the spec doc, custom-styled documents, imports that ship their own CSS) always wins. The article defaults to `max-width: 720px; margin: 64px auto; padding: 0 32px;` so every doc gets real page-like margins without opting in.

Why this matters for imports: `rwa import file.md` and `/import` previously produced an `<article>` wrapped over the converted HTML *with no stylesheet*, so the body rendered as browser-default Times New Roman with no margins. With the baseline in place, markdown/csv/docx/pdf imports now look like a styled document the moment they open.

### Print stylesheet

`seeds/rewritable.html` now ships `@page { margin: 18mm; }` plus a `@media print` block that:

- Hides `#rwa-runtime` (status indicator, settings panel, lens).
- Resets `body` to white/black and removes the `padding-bottom: 160px` lens reservation.
- Collapses the baseline `article` margin/padding so `@page` owns the paper margin.
- Sets `break-after: avoid` on all headings (no stranded H1/H2 at page-end).
- Sets `break-inside: avoid` on figures, pre, blockquote, table, tr, li, img.
- Sets `orphans: 3; widows: 3` on paragraphs.
- Forces link color to black so blue underlines don't ink poorly on monochrome printers.
- Forces `-webkit-print-color-adjust: exact` so document-defined colors survive.

### Test harness updates

Conformance and e2e tests that anchored on the old `Hello, world.` / `<div class="hello">` seed default were updated to anchor on the new seed's strings (`Untitled`, `writing`/`editing`/`thinking`/`planning` for chain tests, `placeholder` for the ambiguous-anchor retry test, `</article>` for the structural-shape-change test). Behaviorally identical — the tests still exercise the same protocol failure modes; they just point at the new seed's content. 42/42 conformance and 291/291 e2e/lens tests pass.

## 2026-05-17 — share subdomain isolation: each share gets its own origin

Published snapshots now live at `https://<short>.rewritable.ikangai.com/` instead of `https://rewritable.ikangai.com/s/<short>`. Each share has its own origin, so the browser's same-origin policy structurally isolates every share's IndexedDB, sessionStorage, and OPFS. A malicious publisher's bootstrap can no longer enumerate `indexedDB.databases()` to find — let alone read — any other share's storage, and the OpenRouter API key a viewer typed into one share never leaks into another.

Design + runbook: [`docs/plans/2026-05-17-share-subdomain-isolation.md`](docs/plans/2026-05-17-share-subdomain-isolation.md), [`service/acme-dns/README.md`](service/acme-dns/README.md).

### The threat this closes

Before this change, every `/s/<short>` share served from `rewritable.ikangai.com`. `service/server.js`'s `validateContainer()` only structurally validates the uploaded bytes (DOC_UUID line, bootstrap marker, INLINE_DOC marker); the bootstrap *script content* is never validated. So a publisher could upload a container with arbitrary JS in the bootstrap and trick a victim into opening the resulting `/s/<short>` URL. That JS ran in the `rewritable.ikangai.com` origin — same origin as every other share — so it could read the victim's `sessionStorage` (OpenRouter API key from any earlier legit share), enumerate `indexedDB.databases()`, dump every `rwa_<UUID>` IDB at the origin, and exfiltrate via `fetch()`. UUID-namespacing of IDB and OPFS doesn't help here because the malicious script is *in* the origin and can read everything. Origin isolation is the architectural fix; per-script auditing of bootstrap bytes was rejected as too brittle as the bootstrap evolves.

### What changed for users

- **New share URL shape.** `POST /publish` now returns `https://<short>.rewritable.ikangai.com/` instead of `https://rewritable.ikangai.com/s/<short>`. The URL is barely longer (31 chars vs. 29) and bookmarks/history/copy-link behave naturally per-share.
- **Legacy URLs keep working.** `https://rewritable.ikangai.com/s/<short>` returns `301 Moved Permanently` to the host-keyed form, with `Cache-Control: public, max-age=86400`. Within the 24h share-expiry window of pre-migration shares, every old URL still resolves to its share. After that the redirect can be removed (or kept indefinitely as cheap insurance).
- **`/robots.txt` on share hosts** serves `User-agent: *\nDisallow: /` so crawlers stay out of 24h-ephemeral content.
- **Local dev unchanged.** Wildcard DNS doesn't resolve against `localhost`, so `node service/server.js` in dev keeps the path-keyed `/s/<short>` form working as a fallback when `req.headers.host` looks local (matching `localhost`, `127.0.0.1`, `[::1]`, or `*.local`).

### Infrastructure: DNS-01 wildcard cert via acme-dns

The wildcard cert (`*.rewritable.ikangai.com`) requires DNS-01 challenges (Let's Encrypt forbids HTTP-01 wildcards by policy). World4You — our DNS host — has no `lego` provider and their self-serve GUI doesn't expose NS records, so two non-obvious paths got rejected: native DNS-01 against World4You's API, and a self-hosted `joohoi/acme-dns` instance delegated via NS records (`acme-dns.ikangai.com` → VPS).

The path that shipped delegates *only* the `_acme-challenge.rewritable.ikangai.com` subdomain to the public `auth.acme-dns.io` service via a single CNAME at World4You. Traefik gains a second cert resolver (`letsencrypt-dns`) alongside the existing HTTP-01 `letsencrypt`, configured to talk to `https://auth.acme-dns.io` via lego's `acme-dns` provider. Trade-off: a third party joins the cert renewal chain. Documented in [`service/acme-dns/README.md`](service/acme-dns/README.md); if `auth.acme-dns.io` ever becomes unreliable, we can re-register with a different acme-dns instance and rotate the CNAME in one step.

### Where the changes live

- **DNS at World4You** — one new CNAME (`_acme-challenge.rewritable.ikangai.com → <random>.auth.acme-dns.io.`). The pre-existing wildcard `*.rewritable.ikangai.com → 185.164.4.77` A record handles share-host resolution.
- **Traefik** (`/opt/docker/router/docker-compose.yml` on the production VPS) — new `letsencrypt-dns` cert resolver + lego env vars (`ACME_DNS_API_BASE`, `ACME_DNS_STORAGE_PATH`) + accounts JSON in the existing `/letsencrypt` volume. Wildcard cert issued by Let's Encrypt R13, stored in `/letsencrypt/acme-dns.json`, auto-renews every ~60 days. Diagnostic `--log.level=INFO` flag added during deploy; kept for future visibility.
- **Rewritable container** (`service/docker-compose.prod.yml` + the host's `docker-compose.yml`) — two routers now share the `rewritable-svc` service: `rewritable-apex` (Host=`rewritable.ikangai.com`, HTTP-01 cert) and `rewritable-shares` (HostRegexp matching exactly 8-char-alphanumeric share hosts under `rewritable.ikangai.com`, wildcard cert via `letsencrypt-dns`).
- **Server.js** — new `SHORT_HOST_RE = /^([0-9a-z]{8})\.rewritable\./` + `isLocalHost(host)` helper. `serveShare(short, send)` extracted from the old `/s/<short>` body, now called by both host-keyed and dev-fallback paths. The request handler computes `isShareHost` up front and short-circuits share-host requests: only `/` (serves the share) and `/robots.txt` (returns `Disallow: /`) are valid; every other URL 404s, including all apex routes. `POST /publish` is gated to apex hosts only — a malicious publisher can't bounce `/publish` off a share host to mint a URL relative to a wrong host. `handlePublish()` builds host-keyed URLs in production and path-keyed in local dev. The legacy `/s/<short>` handler 301-redirects to the new form in production, serves path-keyed in dev.

### Non-obvious points

- **The 8-char `[0-9a-z]` namespace is reserved by convention.** Any future subdomain that happens to be exactly 8 lowercase-alphanumeric chars will be intercepted by the share router. Document this constraint; carve specific exceptions with a higher-priority `Host()` rule if needed.
- **Renamed routers.** The previous single `rewritable` router became `rewritable-apex`; the share router is `rewritable-shares`; both reference an explicit `rewritable-svc` service. Required because with two routers sharing a backend, Traefik's implicit service-from-router-name auto-naming breaks.
- **Existing share files survive untouched.** The on-disk `<short>.html` + `<short>.json` pairs in `service/data/` are origin-agnostic — they served fine from the new subdomain immediately after deploy without any migration.
- **`/import` lives on the apex and only fetches `/rewritable.html` from the apex** — never touches subdomain shares. The origin separation doesn't break anything in the import flow.

## 2026-05-16 — local model backends: Ollama + LM Studio

The settings panel gains two new backend options that run the rewrite loop entirely on the user's machine. Previously the only options were **OpenRouter** (hosted, paid per token) and **Bridge** (delegating to `claude -p` via a localhost shell shim). Now the runtime can also talk directly to **Ollama** (`localhost:11434`) and **LM Studio** (`localhost:1234`) over their OpenAI-compatible `/v1/chat/completions` endpoint — same multi-turn tool-use loop, same `apply_dsl_plan` / `apply_edits` / `replace_document` envelopes, just a different base URL and no API key.

Design: [`docs/plans/2026-05-16-ollama-lmstudio-backends-design.md`](docs/plans/2026-05-16-ollama-lmstudio-backends-design.md).

### What changed for users

- **Two new backends in ⚙ settings.** Pick `Ollama (localhost)` or `LM Studio (localhost)` from the Backend dropdown. The API-key row disappears (no key required), and a **Base URL** row appears, pre-populated with the localhost default but editable for non-default ports or remote LAN servers. A **Test** button next to it probes `GET <baseUrl>/models`; on success it populates a `<datalist>` so the model input gets autocomplete from the live server.
- **First-run CORS guidance.** A small inline hint under the backend selector tells you exactly what to enable: `OLLAMA_ORIGINS=*` (or your origin) before `ollama serve`, or LM Studio → Developer → "Enable CORS". Without these, the browser silently blocks the request — the most common first-run failure mode. The Test button labels CORS-blocked responses explicitly rather than showing a generic network error.
- **Same edit protocol on all three.** The runtime's multi-turn retry loop, tool-call failure feedback, frozen-zone enforcement, and history records are unchanged — `openrouter`, `ollama`, and `lmstudio` all flow through the same `openAiCompatChat()` helper. Picking a local backend doesn't degrade the rewrite loop's behavior; tool-use quality depends on the chosen model.
- **Persisted preferences.** Backend choice, per-backend base-URL overrides, and the model name persist to `sessionStorage` (per-tab, never written to disk). Defaults are `http://localhost:11434/v1` for Ollama and `http://localhost:1234/v1` for LM Studio.

### What changed for the CLI

- **`RWA_BACKEND` and `RWA_MODEL` env vars** are read from `process.env` or `./.env` alongside the existing `OPENROUTER_API_KEY`. When `rwa new -o` / `rwa import -o` opens the fresh container, the CLI appends matching `?backend=` / `?model=` URL params; the bootstrap lifts them into `sessionStorage` and scrubs the URL on first paint, identical to the existing `?key=` flow. So `RWA_BACKEND=ollama RWA_MODEL=llama3.1:latest rwa new -o` lands a fresh container already wired to local Ollama with no manual settings step. Valid `RWA_BACKEND` values: `openrouter`, `ollama`, `lmstudio`, `bridge`. Invalid values are ignored (the bootstrap falls back to the default backend rather than erroring).
- **Help text** (`rwa --help`) now documents both new env vars under `--open`.

### What changed for the runtime

- **`resolveBackendConfig()`** new helper in `seeds/rewritable.html`. Maps the `rwa_backend` sessionStorage value into a transport config: `{kind:'openai_compat', baseUrl, apiKey, extraHeaders, requiresKey}` for the three OpenAI-compatible backends, or `{kind:'bridge'}` for the bridge transport. Centralizes the per-backend decisions that were previously inlined at each call site.
- **URL-param lifting extended** in the bootstrap. The pre-existing `?key=` lifting (read from `URLSearchParams(location.search)`, write to `sessionStorage`, scrub via `history.replaceState`) now also handles `?backend=` (validated against the four allowed values) and `?model=`. All three params are lifted-and-scrubbed atomically — either all-or-none of them remain in the URL after first paint.
- **`openAiCompatChat(cfg, body)`** new helper. Single `fetch` against `<baseUrl>/chat/completions` with `Authorization: Bearer <key>` only when `cfg.apiKey` is set. `modify()` and `callAgentSingleShot()` both route through this helper now; the OpenRouter-specific `HTTP-Referer` and `X-Title` headers are carried via `cfg.extraHeaders` only for the openrouter backend.
- **`listOpenAiCompatModels(cfg)`** new helper. `GET <baseUrl>/models`, returns an array of model id strings. Used by the Test button to populate the model `<datalist>`.
- **Settings UI** (`buildUI()`): backend `<select>` gains `ollama` / `lmstudio` options; new `<input id="rwa-base-url">` with a sibling Test button (`#rwa-base-url-test`) and result line (`#rwa-base-url-result`); new hint row (`#rwa-set-row-hint`) with per-backend CORS guidance; model input gains `list="rwa-model-options"` for autocomplete.

### What changed for the specs

- No spec changes. The edit protocol (rwa-edit/1), DSL (rwa-edit-dsl/1), lens model (rwa-lens/1), and container spec are unchanged — this is a transport-layer addition, not a protocol change.

### What changed for CLAUDE.md

- New **Agent backends** table under "Agent contract" enumerating openrouter / ollama / lmstudio / bridge with their transports, tool-use behavior, and setup requirements.
- Storage tier table updated: `sessionStorage` now lists "API key + backend choice + per-backend base-URL overrides + model name" rather than just the OpenRouter key.

### Backward compatibility

- OpenRouter remains the default backend for new containers. Containers minted before this change carry their original bootstrap and don't get the new options; new containers from `rwa new`, `/new`, `/import`, and `/s/<short>` get them automatically.
- All existing sessionStorage keys (`rwa_apikey`, `rwa_model`, `rwa_backend`) retain their semantics. New keys (`rwa_base_url_ollama`, `rwa_base_url_lmstudio`) are only read when their respective backends are selected.
- Existing tests pass without modification: 291 e2e scenarios + 246 lens scenarios + 42 conformance scenarios.

## 2026-05-16 — agent-facing skill rewritten for v0.10 + `GET /skill.zip` bundle

The rewritable-building skill that the landing page hands to external agents (Claude, Codex, Cursor, …) was significantly out of date. The shipped copy described the v0.6/v0.7 components-directory build (`meta.json` + separate `document.{html,css,js}` + `scripts/build_container.py`) and the pre-v0.10 `{html, css, js}` modify payload — none of which exist anymore. Worse, the markdown referenced files (`scripts/`, `references/`, `assets/`) the "Copy the rewritable skill" button never delivered, so any agent following the workflow would chase dead pointers.

This change rewrites the skill against the actual current architecture (container spec v0.10, rwa-edit/1 v1.4, rwa-lens/1 v0.9) and adds a multi-file bundle at `GET /skill.zip` for agents that prefer files over a single pasted markdown blob.

### What changed for users (agent authors)

- **The Copy button now delivers a working skill.** The new `SKILL.md` is fully self-contained — no references to files outside its own body. The build recipe collapses to three steps: `curl /rewritable.html`, replace the `INLINE_DOC` backticked body (applying the four template-literal escapes: `\\`, `` \` ``, `\${`, `<\/script`), hand the file back.
- **`window.runtime` is taught as a public contract.** The v0.10 surface — `runtime.id`, `runtime.db.{open,get,put,del,all,subscribe}`, `runtime.fs.{read,write,del,list}`, `runtime.modify/commit/undo`, `runtime.status`, `runtime.on` — is documented with signatures and one-line behavior notes. `RwaReservedError` enforcement on `^rwa_` store names and the `_rwa/` OPFS prefix is spelled out. `runtime.shared.*` is flagged as deferred.
- **Two worked INLINE_DOC examples** ship inline in the skill text and as standalone files in the zip: a minimal pure-prose document (`page.html`, 792 B) and a runtime.db-backed task tracker with frozen zones (`task-tracker.html`, 3.4 KB) — autoIncrement keys, subscribe→render round-trip, HTML-escape discipline. Both have been smoke-tested end-to-end through the production `cli/src/seed.mjs` splice + a real browser session: runtime API confirmed exposed, IDB persistence confirmed, lens docked correctly, reserved-namespace enforcement confirmed throwing `RwaReservedError`.
- **"Download skill.zip" button** on the landing page, next to the existing "Copy the rewritable skill" action. Same content; pick whichever fits the agent's ingestion model.
- **Stale "components-directory layout" copy** on the landing rewritten to describe the actual v0.10 flow (fetch + splice + `window.runtime`).

### What changed for the service

- **`GET /skill.zip`** new endpoint. Returns a STORED-only zip (no compression — the bundle is too small to benefit) built once at startup from the same `skillBody` buffer the landing page inlines, plus every `.html` under `service/public/skill/examples/`. `Content-Type: application/zip`, `Content-Disposition: attachment; filename="rewritable-skill.zip"`, `Cache-Control: public, max-age=300`. The bytes are deterministic across restarts (pinned DOS mtime) so the cache header is honest.
- **Inline STORED-zip writer** (~70 lines) in `service/server.js`. Uses `node:zlib.crc32` (Node 18.5+) for the required entry CRCs. Zero new dependencies — still Node `http` + `zlib` only.
- **New asset directory `service/public/skill/examples/`** with two standalone INLINE_DOC body fragments. Each is a complete fragment with a header comment explaining where to splice it.
- **`service/public/build-skill.md`** rewritten end-to-end: 136 lines (v0.6 framing) → 493 lines (v0.10 self-contained). Largest section is the `window.runtime` API surface; second-largest is the design-tokens table; third is the worked examples.
- **`service/public/landing.html`** gains the second button using the existing `.btn-secondary` class.

### What changed for the specs

- No spec changes. This is a documentation and packaging update — the underlying container, edit-protocol, DSL, and lens specs are unchanged.

### What changed for CLAUDE.md

- `service/` entry now lists `/skill.zip` among service endpoints.
- New convention bullet documents the zip build pattern (STORED, deterministic mtime, examples under `service/public/skill/examples/`) and where to edit which file when the skill content changes.

### Backward compatibility

- The "Copy the rewritable skill" button still returns markdown — its byte payload is what changed, not the contract. Agents that already integrated with the copy flow keep working; they just get correct content now.
- `RWA_SKILL_PATH` continues to override the bundled `build-skill.md` for ad-hoc swaps.
- `/skill.zip` is purely additive — every other route is unchanged.

## 2026-05-16 — landing page at `rewritable.ikangai.com/`

The service root now serves a landing page instead of `302`-ing straight to the download. A single URL to share that explains what a rewritable is, the two-step usage flow, the two surfaces (modify loop + build skill), the CLI, the demo gallery, and a FAQ.

Plan: [`docs/plans/2026-05-16-landing-page.md`](docs/plans/2026-05-16-landing-page.md).

### What changed for users

- **`/` is the landing page.** Visit `rewritable.ikangai.com` and you get the pitch + a "Download a fresh container" button (which triggers `/rewritable.html`) and a secondary link to `/import`. Direct download URLs (`/new`, `/rewritable.html`) keep working unchanged.
- **Copy the rewritable-building skill.** A one-click button copies the rewritable Claude/Codex/Cursor skill (`SKILL.md`) to clipboard. Paste it into any agent that can author files and ask for the container you want; the skill teaches it the components-directory layout, the runtime API, and the hard rules.
- **Discoverability.** The landing surfaces the demo gallery (`/demo/html-effectiveness/`), the GitHub repo, and the specs. Previously these had no entry point from the root URL.
- **No tracking, no fonts loaded, no JS framework.** The landing is a single self-contained `.html` with inline CSS and ~50 lines of JS (sticky-header + clipboard handler). Matches the rest of the project's "one file" ethic.

### What changed for the service

- **`GET /`** switches from `302 → /new` to serving `LANDING_HTML` (`200`, `Cache-Control: public, max-age=300`). `/new` stays as the auto-download trigger page, reachable via the landing's "Download" CTA and direct links.
- **`service/public/landing.html`** new asset. Self-contained HTML, design tokens lifted from `playground.ikangai.com` (gray ramp 50–900, semantic green/yellow/red, 24px radius for surfaces, system font UI, SF Mono for code, primary action `gray-900` pill).
- **`service/public/build-skill.md`** new asset. Bundled fallback copy of the rewritable-building `SKILL.md`. Embedded at startup into the landing's `<script type="text/markdown" id="skill-md">` block, defensively escaping any `</script` substrings. The "Copy" button reads from that inline block — no extra fetch.
- **`RWA_SKILL_PATH` env var** overrides the bundled skill location. Missing/unreadable file is non-fatal; the landing still renders, the button copies an empty payload, and the service logs a warning.
- **Zero new dependencies.** Still Node `http` only.

### What changed for the specs

- No spec changes. The landing is a marketing surface that links to the specs; it doesn't define new behavior.

### What changed for CLAUDE.md

- `service/` entry mentions the landing route.
- New service convention paragraph documents the `{{SKILL_MD}}` template marker, the bundled fallback, the `RWA_SKILL_PATH` override, and the rebuild ritual when the skill changes.

### Backward compatibility

- `/new` and `/rewritable.html` are unchanged. Existing share/install URLs continue to work.
- The only breaking change is the URL behavior at `/`: it now returns the landing HTML instead of a redirect. Tooling that relied on the `302 → /new` chain should switch to hitting `/new` directly (which has always been the canonical auto-download endpoint).

## 2026-05-16 — snapshot publishing: `rewritable.ikangai.com/s/<short>`

The service now hosts anonymous 24h snapshots of any rewritable. Click **Publish & share** on `/new` or `/import`, get back a public URL, hand it to anyone. The published bytes are immutable; each viewer's edits land in their own browser-local IDB, never propagate back to the publisher. No accounts, no paywall, no signup.

Plan: [`docs/plans/2026-05-16-snapshot-publishing.md`](docs/plans/2026-05-16-snapshot-publishing.md).

### What changed for users

- **`/new` page** now exposes a "publish a hosted snapshot online →" link below the auto-download. Click it and the service fetches a fresh container, publishes it, and surfaces the share URL with a copy button + UTC expiry timestamp.
- **`/import` page** surfaces a "Publish & share" card after a successful conversion. The just-built container bytes are POSTed directly to `/publish` — no re-fetch needed.
- **Share URLs** look like `https://rewritable.ikangai.com/s/<short>` (8 chars, `[0-9a-z]`). Anyone with the link can open the snapshot; they get a fresh per-share `DOC_UUID` so their browser-local IDB is namespaced separately from the publisher's local copy.
- **24h expiry.** After 24 hours `GET /s/<short>` returns `410 Gone`. An hourly server-side sweep deletes the underlying files. For longer-lived or collaborative hosting, host the `.html` yourself — any static host works; the file is the app.

### What changed for the service

- **`POST /publish`** endpoint. Accepts a rewritable container body (max 25 MB), validates it (must contain exactly one `DOC_UUID` line plus the `rwa-bootstrap` script tag and the `INLINE_DOC` marker), substitutes a fresh `DOC_UUID`, and atomic-writes `<short>.html` + `<short>.json` to `service/data/`. Returns `201 {short, url, expiresAt}`. Validation failure → `400` with structured `{error, detail}`. Body overflow → `413`.
- **`GET /s/<short>`** endpoint. Validates short against `[0-9a-z]{8}`, reads the metadata sidecar, serves the bytes with `Cache-Control: public, max-age=300`. `404` missing, `410` expired.
- **Rate limit.** 10 publishes/hour per IP, sliding window in-memory. Behind Traefik the client IP is read from the leftmost `X-Forwarded-For` hop; direct-to-port requests use the socket peer.
- **Expiry sweep.** Runs on startup + hourly. Deletes shares older than 24h, orphan `.html` (no metadata sidecar), and corrupt/unreadable metadata. Sweep failures are logged and don't crash the server.
- **Storage layout.** `service/data/<short>.html` + `service/data/<short>.json`. Named volume `rwa_shares` in prod (`docker-compose.prod.yml`); bind-mounted `./data` in dev. A `.gitkeep` keeps the directory in version control without leaking share contents.
- **Zero new dependencies.** The service stays Node `http` only.

### What changed for the specs

- No spec changes. Snapshot publishing is a service capability that operates on the byte format the container spec already defines. The fresh `DOC_UUID` per share is consistent with the v0.7 isolation invariant (each container has its own UUID).

### What changed for CLAUDE.md

- `/s/` URL prefix is now a reserved namespace.
- `service/data/` is documented as operator-readable but never in version control (matches `.gitignore`).

### Backward compatibility

- No container-format or edit-protocol changes. Existing rewritables can be published unchanged.
- The published bytes differ from what the user uploaded by exactly one substitution — the `DOC_UUID` line. By design: each share is its own container.

### Known limitations

- **Same-origin OPFS isolation gap.** All `/s/<short>` shares co-share `rewritable.ikangai.com` as their origin. Structured IDB stores are namespaced by per-share `DOC_UUID` (`rwa_<DOC_UUID>`), and `runtime.fs.*` namespaces OPFS the same way (`_<DOC_UUID>/`). But non-namespaced OPFS access (direct `navigator.storage.getDirectory()`) is still shared null-origin and would leak across shares. Subdomain isolation (`<short>.s.rewritable.ikangai.com`) is the eventual fix and would require Traefik wildcard routing + cert.
- **No content moderation.** Anonymous publishing; 24h expiry is the only automated mitigation. The operator can manually delete a `<short>.{html,json}` pair to take down a share early.
- **No CSRF protection on `/publish`.** Cross-origin POSTs are accepted. The published bytes are public anyway and the per-IP rate limit caps abuse — CSRF doesn't yield privileged action.
- **No in-container Share button.** A downloaded rewritable can't currently publish itself from its own ⌘S workflow. Use `/import` or `/new` on the service for publishing.

## 2026-05-16 — public runtime API (spec v0.10): `window.runtime` is now a contract

Container spec bumped to **v0.10**. The §7 surface — previously a sketch — is now wired through the seed and exercised end-to-end by the test harness. Documents inside a re-writeable can finally read and write their own structured data, persist blobs to an isolated OPFS namespace, drive the modify loop programmatically, and observe state changes. The result: trackers, dashboards, multi-store apps become first-class — the seed is no longer the only fully-supported document shape. As a side payload, the OPFS isolation gap from §5.7 is closed; each container's blobs now live under `_<DOC_UUID>/`, mirroring the v0.7 IDB invariant.

Plan: [`docs/plans/2026-05-16-public-runtime-api.md`](docs/plans/2026-05-16-public-runtime-api.md). The bootstrap meta tag stays at `rwa-bootstrap` 0.9 — its shape is unchanged; the new API is purely additive.

### What changed for users (document authors)

A new global `window.runtime` is available on every container that boots cleanly (private mode early-returns without setting it). It exposes:

```js
runtime.id;                                         // string — the container's DOC_UUID
runtime.db.open(name, { autoIncrement });           // declare a document-owned store (rejects rwa_*)
runtime.db.get(store, key);                         // read
runtime.db.put(store, key, value);                  // write (autoIncrement: pass null/undefined for key)
runtime.db.del(store, key);
runtime.db.all(store);                              // → [{key, value}, ...]
runtime.db.subscribe(store, cb);                    // BroadcastChannel-backed; returns unsubscribe fn

runtime.fs.write(path, blob);                       // OPFS, auto-namespaced under _<DOC_UUID>/
runtime.fs.read(path);                              // → Blob
runtime.fs.del(path);
runtime.fs.list(prefix);                            // → [{name, kind}, ...]

runtime.modify(instruction);                        // ⌘K programmatic equivalent
runtime.commit();                                   // ⌘S
runtime.undo();                                     // ⌘Z

runtime.status;                                     // observable getter — { dirty, fsa, storage }
runtime.on('commit' | 'modify' | 'status', cb);     // event subscription; returns unsubscribe fn
```

Documents that need structured data or blobs no longer have to roll their own IDB/OPFS access. Reserved-namespace enforcement is consistent: `^rwa_` store names and the `_rwa/` OPFS prefix throw `RwaReservedError` on every operation. Path validation rejects empty strings, leading slashes, and `.`/`..` segments with descriptive errors.

### What changed for the seed

- **New IDB versioning strategy.** `openDB()` is now probe-then-upgrade: open without specifying a version to learn the current state, detect missing required or user-declared stores, then close and reopen with `existingVersion + 1` running an upgrade handler that materializes the deltas. Replaces the previous schema-recreate path; the legacy in-line-key branch is preserved as defense-in-depth for any pre-prototype container.
- **User-store registry** persisted to `rwa_state['user_stores']`. On bootstrap, declarations from prior sessions trigger the upgrade handler before document code runs — `runtime.db.put('mystore', …)` works on the first call after reload without the document re-declaring.
- **`_dbVersionBumpInFlight` latch** serializes concurrent `runtime.db.open` calls so two simultaneous declarations don't race the version bump.
- **Producer-side BroadcastChannel cache** plus a separate-channel pattern for subscribers (since BroadcastChannel doesn't deliver self-postMessages). Per-store channels keyed by `'rwa_<DOC_UUID>:<store>'`. autoIncrement keys (assigned by IDB at write time) are captured and forwarded to subscribers in the event payload.
- **5-value FSA state machine** (`unsupported` / `prompt` / `granted` / `denied` / `lost`) centralized in `commit()`. `'lost'` fires when a `createWritable`/`write`/`close` cycle throws `InvalidStateError`, so subscribers can show a "reattach" affordance.
- **Storage estimate captured** inside `rwaCheckQuota` (Task 2 of mobile-safety) so `runtime.status.storage` is current after every modify.
- **Microtask-deferred event emit** at each modify-success site (`queueMicrotask(() => emit(...))`) so the modify mutex is released before listeners run — a listener calling `runtime.modify(...)` re-entrantly no longer hits `concurrent_modify`.
- **OPFS per-container namespace** `_<DOC_UUID>/` auto-applied by `runtime.fs.*`. Documents see clean relative paths; the on-disk OPFS isolates containers the same way IDB does. Direct OPFS access bypassing the runtime API is still shared null-origin — the API IS the isolation boundary.
- **Recursive delete** for `runtime.fs.del` (`{ recursive: true }`) so non-empty directory removal works in real browsers.

### What changed for testing

- **244/244 lens** (was 172 — 72 new assertions across R1.* through R5.9, including reload-survival, re-entrance, throw-isolation, mismatched-options rejection, dot-segment rejection, and per-container namespace verification).
- **291/291 e2e** unchanged.
- **42/42 conformance** unchanged.
- Three `fix(api)` commits in the history document the review cycle: Task 1's API parameter order needed flipping (spec says `put(store, key, value)`; impl had inherited `(store, value, key)` from the internal `idbPut`); Task 2's idempotent-open silently accepted mismatched `autoIncrement` opts; Task 5's `runtime.fs.read` raw `DOMException` was rewrapped with path context.

### What changed for the specs

- **§5.3** — new paragraph after the reserved-namespaces list documents the OPFS per-container prefix and the API-as-boundary semantics.
- **§5.7** — the "OPFS is not yet namespaced — known gap" line is replaced with a description of the closure.
- **§11.5** — the "OPFS isolation" open-question bullet is rewritten as closed (spec v0.10), noting that direct OPFS access bypassing the runtime API is still shared.
- **Closing summary** at the end of `re-write-able-spec.md` adds the v0.10 paragraph above the v0.9 entry (reverse-chronological pattern).

### What changed for references

- `hello.html` and `re-write-able-spec.html` regenerated. Three distinct `DOC_UUID`s preserved; bootstrap content mirrors the seed.

### Backward compatibility

- **No edit-protocol changes.** `apply_edits`, `apply_dsl_plan`, `replace_document` envelopes and semantics are unchanged.
- **No bootstrap shape changes.** The meta tag stays at `rwa-bootstrap` 0.9. Loader, IDB hydration, FROZEN/INLINE_DOC handling, and DOC_UUID byte-identity rules are byte-identical to v0.9.
- **`openDB()` refactor is backward-compatible.** Pre-existing containers with only `REQUIRED_STORES` and no user declarations open with no version bump (probe succeeds, no upgrade needed).
- **`runtime.shared.*` is still deferred** — the §11.5 open questions (naming, conflict resolution, schema/discovery, cross-host bridging) are unchanged and still gate that surface.

### Known limitations

- **`runtime.shared.*` is the only piece of §7 not shipped.** Tracked in §11.5 as the next plan.
- **Direct OPFS access (bypassing `runtime.fs.*`) is still shared null-origin.** The API is the isolation boundary; documents that call `navigator.storage.getDirectory()` directly are opting out of isolation.
- **OPFS is unavailable under `file://` origins in Chromium.** `navigator.storage.getDirectory()` throws `SecurityError` when the container is opened directly from disk, even though IDB works fine there. `runtime.fs.*` now catches this and throws a clear message pointing the document author to HTTP hosting. Documents that need blob storage on disk should fall back to storing Blob values in IDB via `runtime.db.*` for now. (IDB-backed fallback inside `runtime.fs.*` is tracked for a future revision.)
- **No mid-stream streaming for `runtime.modify`.** The wrapper awaits the full modify cycle before resolving. Streaming UX is open per the rwa-lens spec §11.2 and remains conservative for now.
- **Bootstrap meta tag stays at 0.9.** The spec text and CHANGELOG headers reference spec v0.10, but the seed's `<meta name="rwa-bootstrap" content="0.9">` is intentional: the bootstrap shape didn't change, only the API surface added.

## 2026-05-16 — mobile-safety net: commit nudge, quota warning, private-mode banner

Closes three iOS Safari safety gaps the spec promised but the seed never delivered. The runtime now nudges before silent data loss, warns before storage exhaustion, and refuses to operate in private mode where IDB can be evicted at any moment. No spec changes — §5.3 (quota awareness), §5.6 (commit nudge), and §9.1 (private-mode unsupported) already described the behavior; this release ships the implementation.

Plan: [`docs/plans/2026-05-16-mobile-safety-net.md`](docs/plans/2026-05-16-mobile-safety-net.md).

### What changed for users

- **Commit nudge.** After 5 uncommitted modifications, a toast appears: *"You have N uncommitted changes. ⌘S to commit."* The counter persists across tab reloads (lives in IDB), so opening a stale tab still surfaces the prompt. Resets to 0 on every successful commit (FSA in-place or download).
- **Storage-quota warning.** When `navigator.storage.estimate()` reports usage above 80%, a toast surfaces: *"storage 86/95 MB (>80%) — commit & close idle tabs"* (numbers vary). The warning self-clears when usage drops back below the threshold (e.g., after a commit). Checked on boot and after every successful modify.
- **Private-mode blocking banner.** A full-viewport `role="alert"` overlay with the spec wording *"re-write-able requires normal browsing mode"* appears in private/incognito browsers. The runtime early-exits the bootstrap IIFE — no buildUI, no IDB open, no modify pathway — because every operation past detection would silently lose work. Detection uses two signals OR'd together: `navigator.storage.estimate().quota < 50 MB` (catches iOS Safari private, which caps at single-digit MB) and a catastrophic `openDB()` throw (catches environments where the API isn't available at all).

### What changed for the seed

- New IDB store `rwa_state` added to `REQUIRED_STORES`. Holds the dirty-modification counter at key `dirty_count`. Auto-created on next open of any existing container via the existing schema-recreate path.
- New `RWA` config entries: `STATE:'rwa_state'`, `NUDGE_THRESHOLD:5`.
- New helpers in the runtime layer: `rwaGetDirtyCount`, `rwaSetDirtyCount`, `rwaBumpDirtyCount`, `rwaResetDirtyCount`, `rwaResetOnCommit`, `showCommitNudge`, `clearCommitNudge`, `rwaCheckQuota`, `showQuotaWarning`, `clearQuotaWarning`, `rwaDetectPrivateMode`, `rwaShowPrivateModeBanner`.
- Counter wired into all four modify-success paths (`modify`, `modifyViaBridge`, `runAnchoredCommand`, `synthesizeAndCommit`) immediately after `renderDoc` and `setDirty(true)`. Quota check fires fire-and-forget at the same five sites plus once on boot. All counter writes are `.catch(() => {})`-wrapped — the counter is a UX hint, never blocks the edit.
- Counter rehydrated on bootstrap: if the persisted count crosses the threshold, the nudge is shown immediately on open.
- Two new singleton toasts share the existing `.rwa-lens-toast` class, discriminated by `data-kind="commit-nudge"` and `data-kind="quota-warn"`. New CSS for `#rwa-private-mode-banner` (full-viewport `inset:0`, `z-index:9999`, white card).
- Bootstrap IIFE re-ordered: private-mode detection runs as the first non-trivial statement, before any UI or IDB work. A second detection catches `openDB()` throws and renders the same banner. Both early-return, cleanly short-circuiting all subsequent init (no quota check, no counter rehydrate, no listeners).

### What changed for testing

- **172/172 lens-tests pass** (was 147 — 25 new assertions across phases M1.*–M3.*).
- **291/291 e2e pass** unchanged.
- **42/42 conformance pass** unchanged.
- New phases in `tests/lens.mjs`:
    - M1.1–M1.5 cover the counter increment, threshold-crossing toast, reset/clear, IDB round-trip, and lens-path coverage (driving `submitLens` for direct text and anchored slash to verify those paths bump the counter).
    - M2.1–M2.3 cover the quota toast (visible surface), the self-clear branch (pre-populated toast clears when usage drops), and the `estimate()`-unsupported no-op.
    - M3.1–M3.4 cover detection (true on 1 MB quota, false on 5 GB), banner rendering with the spec wording and `role="alert"`, and safe-default when `estimate()` is absent.
- Two `fix(safety)` commits in the history document the review cycle: Task 1 originally missed the lens paths (fixed); Task 2 originally surfaced via `setPalSt('warn', …)` which lands in a closed modal palette the user never sees (fixed to use the visible toast surface).

### What changed for references

- `hello.html` and `re-write-able-spec.html` regenerated. Their `INLINE_DOC` content is preserved verbatim; the bootstrap mirrors the new seed. Each retains its distinct DOC_UUID (no clobbering — the v0.7 invariant holds).

### Backward compatibility

- **No edit-protocol changes.** `apply_edits`, `apply_dsl_plan`, `replace_document` envelopes and semantics are unchanged.
- **No spec changes.** The container spec, edit spec, DSL spec, and lens spec are byte-identical to before this release.
- **New IDB store `rwa_state` is auto-created** on next open of any pre-mobile-safety container via the existing `openDB()` upgrade path. No migration step required.
- **Existing containers carry the new runtime** by virtue of regeneration (the references) or by being unmodified (existing user containers re-open with their old runtime; the new safety net activates only after the user regenerates from the seed or imports fresh).

### Known limitations

- **Toast overlap.** `showCommitNudge` and `showQuotaWarning` both render at `.rwa-lens-toast`'s shared coordinates (`bottom:140px; left:50%`). If both fire concurrently they stack at identical Z; the user reads only one. Low-incidence interaction (the user must cross both threshold 5 AND 80% usage in the same step) — deferred polish.
- **`openPal` is not defensive about missing UI.** In private mode the early-return skips `buildUI`, so `#rwa-pal` does not exist; pressing ⌘K would throw on `null.classList`. The throw goes to console, not the user. Deferred polish.
- **No automated IIFE-level integration test.** Unit tests cover each helper; the end-to-end "private mode triggers banner AND skips quota+counter init" path is left to the manual browser smoke per `docs/plans/2026-05-16-mobile-safety-net.md#step-43`.

## 2026-05-16 — bootstrap 0.9: stable block IDs + URL-fragment scroll (web hardening, phase 1)

Re-writeable containers become first-class citizens of the open web. The runtime now backfills a stable `data-rwa-id` on every anchorable block at bootstrap and at every commit, and resolves URL fragments against either a literal `id=` or a runtime-assigned `data-rwa-id`. A link like `https://you.com/notes.html#7k3p2m9q` continues to resolve to the same block after the surrounding text has been rewritten any number of times. Container spec bumped to **v0.9**; rwa-edit/1 stays at v1.4 (no protocol change — `data-rwa-id` is part of the doc text the agent must respect).

Design document: [`docs/plans/2026-05-15-web-hardening-design.md`](docs/plans/2026-05-15-web-hardening-design.md) (Phase 1 scoped; later phases — transclusion, overlay metadata, sandboxed embedding — sketched).

### What changed for users

- **Every paragraph, heading, list item, blockquote, figure, pre, and aside in a stored doc has a stable name.** The runtime assigns an opaque 8-character base32 ID (`crypto.getRandomValues` → 40 bits, ~1e12 codes — collision risk in a single doc is negligible). Author-supplied `id=` values still work and take priority for resolution.
- **URLs link to blocks, not just to pages.** Open `your-notes.html#7k3p2m9q` and the runtime scrolls to that block on initial paint, with a brief blue-tint pulse so the location is obvious. `hashchange` events trigger the same behavior — any in-page navigation works.
- **Frozen zones are skipped.** Comment-fence marker zones (`rwa:frozen:begin/end`) and `data-rwa-frozen` elements are byte-invariant; injecting an attribute inside one would break frozen-zone integrity. The walk excludes them.
- **IDs survive every edit.** `apply_edits`, `apply_dsl_plan`, `replace_document`, undo, commit, export — the IDs round-trip through all of them. The agent contract instructs the agent to preserve existing values verbatim and never invent new ones.

### What changed for the seed

- New `<meta name="rwa-bootstrap" content="0.9">` in `<head>` — a machine-readable version marker.
- New `generateBlockId()` — RFC 4648 lower-base32, 8 chars from 5 random bytes.
- New `injectMissingBlockIds(doc)` — pure string surgery over the source text (preserves whitespace, attribute order, quoting bytes per the format-stability invariant). Mirrors `buildSourcePositionMap`'s scan: same tag set, same masking of script/style/comments, same outer-wins skip past nested anchorables. Returns `{ text, assigned }`; when `assigned === 0` returns the input byte-identical.
- New `scrollToFragment()` — resolves `location.hash` against `#<id>` and `[data-rwa-id="<id>"]`, scrolls smoothly, adds `.rwa-frag-pulse` for 1.7 s.
- New `.rwa-frag-pulse` CSS keyframe — blue tint (`rgba(59,130,246,0.22)`) fading to transparent over 1.6 s.
- `commitDoc()` now backfills IDs on the new doc before persisting, returns the persisted form. Callers consume the return value so re-renders show the augmented text.
- Bootstrap IIFE runs `injectMissingBlockIds` once before the first render; if anything was assigned, persists to IDB and renders the augmented text. Then calls `scrollToFragment` so deep links work on first paint.
- `findReservedIdViolation` no longer rejects `data-rwa-id` — the runtime writes those attributes itself, so a doc containing them is the normal state, not a violation. `#rwa-doc-mount` is still rejected (the render mount remains reserved).
- The `SYSTEM_PROMPT` gains a "Stable block identifiers" section instructing the agent to preserve existing IDs verbatim, copy them through when rewriting a block's text, and never invent new ones.

### What changed for the specs

- `re-write-able-spec.md` → **v0.9**.
    - §5.3 adds `data-rwa-id` and `#rwa-doc-mount` to the runtime-reserved namespace list.
    - §5.9 (new) — "Stable block identifiers and web fragment addressing." Lifecycle (backfill on first encounter, skip frozen zones, preserved across edits), URL-fragment resolution, the Berners-Lee read/write-web framing, and what's deliberately out of scope (transclusion, overlay metadata, sandboxed-iframe hosting).
    - §6.1 (agent contract) adds the verbatim-preservation rule.
- `rwa-edit-spec.md` reserved-table entry for `data-rwa-id` flips from "Reserved for v2" to "Runtime-assigned, document-wide." The "rules for edits" section gets the preservation rule. §17 (potential v2 additions) reframes `data-rwa-id` as a future first-class anchor — IDs already exist on every block; v1 doesn't add the targeting op.
- `CLAUDE.md` reserved-namespace entry updated.

### What changed for testing

- **291/291 e2e pass** against the new seed.
- New tests 116a–f: `injectMissingBlockIds` coverage (anchorable blocks, frozen-zone skip, idempotence), `apply_edits` round-trip preserves IDs, `scrollToFragment` resolves a `data-rwa-id` and applies the pulse, hash that doesn't resolve is a no-op, bootstrap-0.9 meta tag present.
- Tests 13 and 14b retired — they verified that `data-rwa-id` was rejected as a reserved attribute. That invariant is gone; replaced by the positive coverage in 116a–c.
- `benchmark/scenarios/conformance/conform-06.mjs` switched setup from `ctx.replaceDocument` (which now backfills IDs and would produce `<li data-rwa-id="…">foo</li>`, defeating the test's `<li>foo</li>` find anchor) to `ctx.setDoc` (raw IDB) so the test's id-less setup persists.

### What changed for references

- `hello.html` and `re-write-able-spec.html` regenerated from the new seed. Their existing `INLINE_DOC` content is preserved (the regen tool extracts it from each ref and re-injects); the bootstrap mirrors the seed.

### Backward compatibility

- **No edit-protocol changes.** `apply_edits`, `apply_dsl_plan`, `replace_document` envelopes and semantics are unchanged. The agent's only new responsibility is to leave existing `data-rwa-id` values alone.
- **IDB schema unchanged.** The IDs live in the doc text, not in a separate store. Existing containers gain IDs on next bootstrap (one-shot backfill); the augmented text is persisted, so subsequent opens skip the walk.
- **Existing fragment links keep working.** Pages that already used `id=` for headings continue to scroll correctly — `scrollToFragment` resolves either form.

### Known limitations (carried to Phase 2)

- **If the agent strips an ID by replacing an entire block with a new shape**, the runtime backfills *some* ID — but it's a fresh one. The old fragment link is silently broken. Phase 2 may add a strict mode that rejects edits removing IDs.
- **Cross-document transclusion (`<rwa-include src=…>`), overlay metadata (`<meta name="rwa-overlay">`), and sandboxed-iframe hosting wrappers** are designed against this floor but not implemented yet. See the design doc.

## 2026-05-15 — hosted gallery at `/demo/html-effectiveness/`

Twenty single-file HTML examples from [thariqs.github.io/html-effectiveness](https://thariqs.github.io/html-effectiveness/) — each imported into a re-writeable container via `rwa import` — are now served by the production service for offline-friendly side-by-side comparison.

### What changed for users

- **New page at `rewritable.ikangai.com/demo/html-effectiveness/`** — a tabbed index across 20 examples (an empty-state explorer, a design system reference, a slide deck, a flowchart with hand-coded SVG, an interactive kanban triage board, a tabbed code explainer, a research feature explainer, and more). Each entry shows the original web version and its rewritable counterpart in side-by-side iframes. URL hash routes the active example (`#01`–`#20`); "open ↗" links bypass the iframe view.
- **`/new` thank-you page links to the gallery** so first-time users have a discoverable entry into "what does a rewritable look like in practice."
- All twenty examples retain full interactivity through the import — the light/dark toggle (02), arrow-key slide nav (09), tabbed code panes (14), kanban drag-reorder (18), feature-flag toggles (19), and so on all behave the same on the rewritable side, with the lens chrome floating over the document content.

### What changed for the service

- `service/server.js` reads `demo/html-effectiveness/` recursively at startup into an in-memory `Map`. The request handler hits the map, never the filesystem. Startup log reports `demo: loaded 42 files`.
- New routes:
    - `/demo`, `/demo/`, `/demo/html-effectiveness` → 302 → `/demo/html-effectiveness/`
    - `/demo/html-effectiveness/` → index page
    - `/demo/html-effectiveness/<asset>` → static asset by path
- `X-Frame-Options` is overridden to `SAMEORIGIN` on demo paths so the index can iframe the sibling `original/` and `rewritable/` pages — the global `DENY` would block it. `/new`, `/import`, `/rewritable.html` keep `DENY`.
- `service/Dockerfile` adds `COPY demo/html-effectiveness/ ./demo/html-effectiveness/`. Scope-limited to the subdir so any local cruft in `demo/` (e.g. user PDFs) does not enter the image.

### What changed for the repo

- `demo/html-effectiveness/original/<01..20>.html` — pinned copies of the source pages, downloaded `2026-05-13`.
- `demo/html-effectiveness/rewritable/<01..20>.html` — same content imported into re-writeable containers via `rwa import`.
- `demo/html-effectiveness/index.html` — the static tab-navigated comparison index.
- `demo/html-effectiveness/README.md` — source attribution and the regeneration recipe.

### Backward compatibility

- Strict addition. Existing routes (`/new`, `/import`, `/rewritable.html`, `/health`, `/pdf/*`) and their behavior are unchanged. The legacy `X-Frame-Options: DENY` still applies to all of them.
- Demo files are baked into the image at build time; no FS access at request time.
- Production host's `/opt/docker/rewritable/` had a pre-`service/` layout snapshot from April; this deploy upgraded it via `rsync` into the repo's `service/`+`seeds/`+`demo/html-effectiveness/` structure and replaced the top-level `Dockerfile`. Future deploys: `rsync` from the local repo, then `docker compose up -d --build` on the host.

## 2026-05-13 — default styling aligned with playground.ikangai.com

The seed's bootstrap is re-skinned to match the styling of `playground.ikangai.com` — neutral grayscale, system fonts, and a quieter chrome — so re-writeable containers feel like siblings of the playground rather than a separate visual family. Container spec, edit protocol, and runtime behavior are unchanged; this is a CSS-only change.

### What changed for users

- **Neutral grayscale palette.** `--gray-50` (`#fafafa`) through `--gray-900` (`#171717`), plus semantic `--green` / `--yellow` / `--red` / `--blue`. The previous warm-cream + terracotta + Claude-blue scheme is gone. Primary actions (⌘S commit, "command mode" lens border, send button) are `--gray-900`. The status pill for "ok" is `--green` and for "err" is `--red`.
- **System fonts.** UI in `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif`; mono in `'SF Mono', Menlo, Monaco, ui-monospace, monospace`. The Google Fonts `<link>` to DM Sans / DM Mono / Instrument Serif is removed — the bootstrap is now fully self-contained, no third-party font calls, faster first paint.
- **Quieter lens chrome.** Max-width tightened from 740px → **680px** (matches the playground's `.input-area`). Border is `1px solid var(--gray-200)`, shadow is `0 2px 8px rgba(0,0,0,.04)` baseline → `0 4px 16px rgba(0,0,0,.08)` on `:focus-within` — the playground's `.input-wrapper` values. "Command mode" border is `--gray-900` (replaces the terracotta accent).
- **Busy indicator restyled.** The pulsing `⏳` emoji is replaced by a small `--gray-400` pulsing dot at the top-right of the lens.
- **Hello-world heading.** The empty-seed greeting still uses an italic serif heading, now via `Georgia, 'Times New Roman', serif` instead of Instrument Serif. The gradient text-clip is removed in favor of solid `--gray-900` to match the playground's restraint.

### What changed for the seed

- The `<style>` block is rewritten end-to-end. The legacy `--bg` / `--surf` / `--b1` / `--b2` / `--text` / `--muted` / `--accent` / `--blue` aliases are kept and resolve to the new ramp, so any INLINE_DOC referencing them keeps rendering. Two new variables: `--font-ui` and `--font-mono`.
- `INLINE_DOC` font references (DM Mono, Instrument Serif) swapped for system stack + Georgia fallback.
- Print stylesheet comment cleaned up — no more "dark surface" reference.

### What changed for documentation

- `CLAUDE.md` "Design constraints for documents" section updated: palette table, font stack, lens chrome dimensions.

### Backward compatibility

- No runtime, edit-protocol, or schema changes. 274/274 e2e scenarios pass against the new seed.
- The bootstrap byte-identity invariant still holds within this release.
- Existing containers with old DM Sans / Instrument Serif references in their INLINE_DOC continue to render — the fonts fall back to the system stack since the `<link>` is gone. No layout breakage observed in the seed's own hello content.

## 2026-05-12 — rwa-lens/1 edit model: the modal ⌘K becomes a steerable lens

The user-surface layer over rwa-edit/1 changes. The modal `Cmd+K` palette is replaced by a single steerable input — the **lens** — that has two states (default, anchored) and discriminates content from instruction via a leading slash. No new edit protocol; every gesture compiles down to an existing `apply_edits`, `apply_dsl_plan`, or `replace_document` envelope. The container spec stays at v0.8 and the edit protocol stays at rwa-edit/1 (v1.4).

The model also adds class-declared locks (`class="rwa-locked"`) as a UI-affordance layer over the existing frozen-zone mechanism, and a re-skin: the runtime ships a Claude-styled light theme (warm cream `#f5f4ef` / terracotta accent `#cd5d3c`) replacing the previous dark theme.

### What changed for users

- **The lens.** A single text input docked at the bottom of the viewport as a floating max-width 740px white card. Always present, in one of two states:
    - **Default (global).** Direct text (⌘Enter) appends a new block at end-of-document. A slash command (`/dark mode`, `/convert this to a kanban board`) runs the existing multi-turn rwa-edit/1 loop with the whole document as context.
    - **Anchored on a block.** Click any block (`<p>`, `<h1>`–`<h6>`, `<blockquote>`, `<li>`, `<figure>`, `<pre>`, `<aside>`) to anchor the lens beneath it. Direct text now *inserts* a new block after the anchor; a slash command *edits* the anchored block. The badge on the lens shows what it's targeting; `Esc` (or the badge X) releases. A "down" button re-docks at EOF.
- **Slash convention.** No leading slash → direct text (prose). Leading `/` → command. `\/` at the start of a submission produces a literal slash. Live mode indication: the lens chrome shifts (border accent + placeholder + "command" pill) as soon as the input begins with `/`, so the discriminator is visible before submit. Multi-line pastes that start with a slash surface a one-time hint (*escape with `\/` to insert literally*).
- **Class-declared locks.** `class="rwa-locked"` on any block renders it with a stripe + lock icon. Anchoring on it is rejected, edits that overlap it are rejected, and `replace_document` is rejected unless the lock is entirely contained within a marker-form frozen zone (comment fence or `data-rwa-frozen`). The UI affordance for the *this part is fixed, the rest is malleable* use case — contract templates, tax forms, press releases.
- **Collapsible history pane.** A read-only pane lists recent edits with surface (default / anchored), instruction, and scope (whole-doc / single-block). History cap raised from 15 to **1000** entries.
- **Light theme.** Bg `#f5f4ef` (warm cream), surface `#ffffff`, text `#1a1a17`, accents `#cd5d3c` (terracotta) / `#3d7fb8` (blue) / `#c84a4a` (red). Fonts unchanged. Print stylesheet adjusted: lens, history button, status pill all hidden; body padding zeroed.
- **Busy indicator.** A ⏳ pulse animates on the lens while a command is in flight, so the user can see that ⌘Enter registered.
- **Bridge backend works with anchored commands.** Anchored slash commands now route through `claude -p` when the bridge backend is selected, not just OpenRouter.

### What changed for the seed

- New CSS variables and a full re-skin: light palette, floating lens chrome with rounded-24px corners, drop shadow, focus-within glow, command-mode terracotta accent. `body` gains `padding-bottom:160px` so document content scrolls above the floating lens.
- New runtime cluster in `seeds/rewritable.html`: source-position map for `rwa_doc`, click-to-anchor, anchored/default dispatchers, EOF anchor resolution (skips locked tail), `.rwa-locked` source-range tracking, overlap check for `apply_edits` / `apply_dsl_plan`, coverage check for `replace_document`, post-commit anchor re-anchoring / release logic, paste-detection hint, collapsible history pane.
- `rwa_hist` schema extended with `surface` (`default` / `anchored`), `instruction` (user prompt verbatim), and `scope` (`whole-doc` / `single-block`); cap raised 15 → 1000. Schema is additive; existing entries continue to render.
- Direct-text submissions hold the modify mutex; submit errors surface in the lens chrome instead of silently dropping. Default-state slash commands carry `lensMeta` ({surface, scope}) into the audit record.
- New `callBridgeSingleShot` parallel to `callAgentSingleShot` so anchored commands work with both backends.
- Agent prompt for anchored slash commands names `.rwa-locked` blocks explicitly and reminds the agent that `replace_document` cannot remove them; anchored response is validated against the parent context to avoid structurally invalid HTML before envelope construction.

### What changed for the references

- `hello.html` and `re-write-able-spec.html` regenerated from the new seed against the lens runtime. Each preserves its own `DOC_UUID` and `INLINE_DOC` body; the bootstrap mirrors the seed.
- `tools/regenerate-refs.mjs` gains an optional `rewritable.html` target at the repo root so a `rwa new`-produced container can be re-skinned in place during dev.

### What changed for documentation

- New spec `docs/specs/rwa-lens-spec.md` (rwa-lens/1 v0.9). Defines the two states, the slash convention, anchor resolution, the source-position map invariant, post-commit anchor behavior, lock semantics (class-declared vs. marker-form coverage), wrapper rules per anchor type, and the failure modes that need affordances.
- `CLAUDE.md` documents the lens edit model, the four-site alignment for lens changes (spec ↔ seed ↔ regen flow), and the new light-theme palette.

### What changed for testing

- `tests/e2e.mjs`: HIST_CAP assertions updated for the new 1000-entry cap; new tests cover the anchored slash command end-to-end (prompt, validate, envelope, commit), parent-type validation, `.rwa-locked` overlap rejection on `apply_edits`, and `replace_document` coverage rejection.

### Backward compatibility

- **No edit-protocol changes.** rwa-edit/1 envelope shapes and semantics are unchanged. `apply_edits`, `apply_dsl_plan`, and `replace_document` validate identically.
- **`rwa_hist` schema is additive.** New fields (`surface`, `instruction`, `scope`) coexist with legacy entries; the history pane renders both.
- **Existing containers continue to work.** Their bootstrap upgrades only on the next `⌘S` (or by regenerating from the seed). The bootstrap byte-identity invariant still holds across containers within this release.
- **CLI and service unchanged.** Both handle the seed bytes opaquely. The CLI's bundled seed regenerates on the next `npm publish` from the canonical seed.

### Known limitations

- **Definition lists are not in v1's anchorable set.** Clicks on `<dl>`/`<dt>`/`<dd>` content traverse to the nearest anchorable ancestor or no-op.
- **Multi-block responses release the anchor.** When an agent returns more than one anchorable element from an anchored slash command, the lens releases to default with a brief affordance — v1 does not support multi-anchor.
- **The bare `.rwa-locked` class has no protocol-level preservation through `replace_document`.** Authors who want both the UI affordance and `replace_document` survival declare both forms on the same block (comment fence outside, or `data-rwa-frozen` on the same element).

## 2026-05-09 — `-o` hands the OpenRouter key to a fresh container via `?key=`

Quality-of-life fix on the `rwa new -o` / `rwa import -o` path. When `OPENROUTER_API_KEY` is set in the environment (or in a `./.env` file in the working directory), the CLI now appends it to the `file://` URL it opens as `?key=…`. The bootstrap reads the parameter on first paint, lifts it into `sessionStorage`, and immediately scrubs the URL via `history.replaceState` so the key doesn't sit in the location bar, history, or any later bookmark. Without `-o`, behavior is unchanged. Without a key in the environment, behavior is unchanged.

### What changed for users

- `rwa new -o` and `rwa import -o` will now silently bring an OpenRouter key with them when one is available. ⌘K works on first open without visiting the settings panel.
- The CLI prints `note: passing OPENROUTER_API_KEY via ?key= URL parameter` to stderr when it does so.
- A minimal `.env` parser is included (`KEY=value`, optional `export`, optional matched quotes, no interpolation, no multiline). Existing shell-exported env wins.

### What changed for the seed

- The bootstrap gains a ~10-line block right after `RWA` is defined that reads `?key=…` from `location.search`, writes it to `sessionStorage[RWA.K_API]`, and rewrites the URL via `history.replaceState`. Wrapped in `try/catch` because sandboxed `file://` contexts can throw on `history.replaceState`.

### Backward compatibility

- Strict addition. The seed bytes change only by the inserted block; bootstrap byte-identity invariant still holds across containers within this release.
- Bridge backend (`rwa_backend = bridge`) ignores the key — the URL parameter is still consumed and scrubbed, just unused.

## 2026-05-08 — bridge backend: ⌘K via local `claude -p`, plus printable containers

The runtime grows a second agent backend, selectable in the ⚙ settings panel. In addition to the existing OpenRouter HTTP path, ⌘K can now route through a localhost CLI bridge — a `web_cli_bridge`-style endpoint at `http://127.0.0.1:8765/run` that takes `{command}` and returns `{stdout, stderr, exit_code}`. The bridge spawns `claude -p`, which produces a JSON edit envelope; the runtime parses it and dispatches through the existing `applyEdits` / `compileDslPlan` / `replaceDocument` paths. For users with a Claude subscription this is free per call (vs. per-token OpenRouter cost) and uses whatever model their `claude` CLI is configured for.

In the same release, freshly-imported containers print correctly: the runtime chrome (READY pill, ⚙ button, ⌘S button) is hidden via `@media print`, and the import skills/agent are prompted to lay content out for printing.

### What changed for users

- **New "Backend" select** in ⚙ settings. Choose `OpenRouter` (existing HTTP path, requires API key) or `Bridge` (local subprocess, requires `web_cli_bridge` running and `claude` CLI installed). Persisted in `sessionStorage` as `rwa_backend`.
- When `Bridge` is selected, the OpenRouter Key + Model rows hide. They're irrelevant.
- **Containers print as documents, not as web apps.** The status pill, settings cog, and commit button are `display: none` in print media. A blank container's hero placeholder is also hidden.
- **Import paths nudge the agent toward print-fit layouts.** `rwa import --claude` and `--vision` skills are asked to keep imported invoices/letters/forms on a single page where possible, with white background, system fonts, and clean alignment.

### What changed for the seed

- New `RWA.K_BACKEND` constant; new branch in `modify()` selects the backend.
- New `callBridge()` parallel to `callOpenRouter()`. The bridge call shells out `claude -p` with the prompt + tool envelope on stdin; the response is parsed as a single JSON object matching one of the three tool envelopes (`apply_edits`, `apply_dsl_plan`, `replace_document`).
- New `@media print` block hides `#rwa-status`, `#rwa-settings-btn`, `#rwa-commit-btn`, and the empty-state hero. The doc mount itself prints as-is.

### Backward compatibility

- OpenRouter remains the default backend. Existing containers in IDB are unaffected — the `K_BACKEND` slot is read with a default of `openrouter`.
- The bridge endpoint URL is hardcoded to `http://127.0.0.1:8765/run` to match the `web_cli_bridge` convention. Containers that don't have one running surface a connection error in the palette.

## 2026-05-08 — docx + pdf import (CLI + service), with optional `--vision` and `--claude` paths for PDFs

`rwa import` and `rewritable.ikangai.com/import` now accept `.docx` and `.pdf`. By default both run a deterministic offline conversion: mammoth for docx, a pdfjs-driven paragraph heuristic for PDFs. Two opt-in paths exist for PDFs whose layout the heuristic mangles: `--vision` ships the PDF to OpenRouter and asks a vision model for clean HTML, and `--claude` spawns the user's locally-installed `claude` CLI in print mode so the agent can use its official `pdf` / `docx` skills (~/.claude/skills/) and the rich Python tooling those skills carry (pypdf, pdfplumber, pandoc, mammoth, LibreOffice).

### What changed for users

- **`rwa import file.docx`** — mammoth.convertToHtml. Warnings on unmapped styles surface via stderr.
- **`rwa import file.pdf`** — pdfjs walks text items, groups same-y items into lines, flushes paragraphs on y-jumps. Always emits a heuristic warning. Encrypted/scanned PDFs exit cleanly with an error.
- **`rwa import file.pdf --vision [--model …]`** — sends the PDF to OpenRouter (default `google/gemini-3-flash-preview`); the model returns clean HTML. Bypasses the local heuristic. Requires `OPENROUTER_API_KEY`.
- **`rwa import file.{pdf,docx} --claude [--timeout SECS]`** — spawns `claude -p` with the file path on stdin. The agent reads the file with its skill's tools, returns clean HTML on stdout. Default timeout 20 minutes. PDFs with more than ~10 pages are split into page-range chunks and run in up to 4 parallel `claude -p` subprocesses.
- **`/import` accepts `.docx` and `.pdf`** in the browser. Same drop zone, same client-side conversion, same offline guarantee.

### What changed for the CLI

- New runtime deps in `cli/package.json`: `mammoth@1.11.0`, `pdfjs-dist@5.4.149`. Pinned to match cdnjs builds so `/import` stays byte-equivalent.
- `convert(ext, content)` is now `convert(ext, bytes)` — text formats decode utf8 internally, binary formats consume bytes directly.
- `importCmd` reads the input as a `Buffer`.
- New `import-vision.mjs` — wraps OpenRouter chat completions with a base64-encoded PDF and a system prompt asking for `<article>`-wrapped HTML.
- New `import-claude.mjs` — spawns `claude -p`, manages timeout + chunking + parallelism, parses the agent's stdout to extract the `<article>` block. The skills it invokes live in `~/.claude/skills/`; the CLI does not bundle them.
- `--vision` and `--claude` are mutually exclusive and produce a clear error if both are passed.

### What changed for the service

- `service/public/import.html` accepts `.docx` and `.pdf`. mammoth + pdfjs are loaded from cdnjs (mammoth) and self-hosted at `service/public/pdf/{pdf.min.mjs,pdf.worker.min.mjs}` (pdfjs is ESM-only on cdnjs and `integrity=` on `<script type="module">` doesn't validate the URL the inline body imports — self-hosting gives real SRI).
- The browser convertDocx + convertPdf functions are verbatim ports of the CLI's. Mammoth output is passed through `sanitizeMammothUrls` (allowlist: `http`, `https`, `mailto`, `tel`, relatives, `data:image/*` for `<img src>`) — mammoth's tag vocabulary is fixed but it does **not** filter URL schemes, so a docx with a `javascript:` link would otherwise land in `INLINE_DOC` and execute on click. CLI does the same sanitization.
- Four sites must stay aligned when import logic changes: `cli/src/seed.mjs`, `cli/src/import.mjs`, `seeds/rewritable.html`, and `service/public/import.html`. Documented in `CLAUDE.md`.

### What changed for documentation

- `CLAUDE.md` extends the service conventions with the four-site mirror, the pdfjs self-hosting rationale, and the mammoth URL sanitization rule.
- `docs/plans/2026-05-08-docx-pdf-import-design.md` records the design.

### Backward compatibility

- Strict addition for both CLI and service. Existing `.md`/`.html`/`.csv`/`.txt` paths are untouched.
- New CLI runtime deps (`mammoth`, `pdfjs-dist`). `npm i -g rewritable` pulls them transitively.

## 2026-05-05 — DSL structural-transform tool (rwa-edit-dsl/1) shipped in runtime

The runtime gains a third tool, `apply_dsl_plan`, that takes a small typed DSL of structural transforms (`replace`, `insert`, `delete`, `set_attr`, plus a `replace_document` escape) and compiles them deterministically to `apply_edits` envelopes. Sugar on top of rwa-edit/1 — `apply_edits` and `replace_document` semantics are unchanged. The DSL parser is the trust boundary; compiled output flows through the existing `applyEdits` / `replaceDocument` paths so all rwa-edit/1 invariants (frozen zones, structural shape, reserved markers) still hold.

### What changed for users

- **The system prompt has been rewritten** with an explicit structural-vs-content split and a paste-verbatim rule. Even agents that never pick the new tool benefit: gemini-3.1-pro-preview's paste meanT jumped 0.22 → 1.78 on the same `apply_edits` path.
- **A third tool surface is available** to agents that prefer DSL: `replace`, `insert`, `delete`, `set_attr` ops, plus the same `replace_document` escape under a different envelope shape.
- **DSL plans share the audit log with `apply_edits`.** Both land as `kind: 'edit_batch'` in `rwa_hist` (DSL plans flatten to their compiled form before the audit record is written).

### What changed for the runtime

- `seeds/rewritable.html` gains an inline `compileDslPlan` block (~150 lines) that mirrors `benchmark/oracles/dsl-compiler.mjs`. The compiler runs each op against an in-memory shadow doc and emits a single sequential `apply_edits` envelope (or one `replace_document` envelope for the sole-op escape), then dispatches through the existing apply paths.
- `TOOL_SCHEMAS` grows a third entry for `apply_dsl_plan` with a `oneOf` op switch covering all five op shapes.
- `SYSTEM_PROMPT` is rewritten — three-tool description, structural-vs-content preference, plus rules sections per tool.
- The dispatch in `modify()` adds an `apply_dsl_plan` branch that calls `compileDslPlan` and routes the result. Compile errors are reported as `RwaEditError('malformed_envelope', i, { reason: ... })` — the existing failure shape — and flow through `failureToToolResult` → `tool_result` → retry up to 3 times.

### What changed for the references

- `hello.html` and `re-write-able-spec.html` regenerated from the new seed. Each preserves its own `DOC_UUID` and `INLINE_DOC` body; the bootstrap mirrors the seed.

### What changed for the benchmark

- `rwa-edit-dsl/1` is specified in `rwa-edit-dsl-spec.md`. v0.1, sole-source.
- `benchmark/oracles/dsl-compiler.mjs` ports the same compile-down semantics for offline use.
- `benchmark/runners/run-fidelity-dsl.mjs` is a new round-trip oracle (`npm run fidelity:dsl`): feeds each scenario's `expectedDslPlan` to the compiler, applies both the stub envelope and the compiled envelope to the fixture, and asserts byte-equal output. **12/12 expressible scenarios pass.**
- `benchmark/runners/dsl-mode.mjs` and `benchmark/runners/hybrid-mode.mjs` are real-model runners exploring the DSL-only and supervisor+worker architectures. Surfaced as `node runners/run-fidelity.mjs <model> dsl` and `... hybrid` modes.
- 89 fidelity scenarios get a `tag` field for the architecture-comparison axis (`structural_regular`, `structural_irregular`, `content`, `mixed`, `paste`, `failure_mode`, `drift`, `runtime`).
- 9 new scenarios fill gaps the May 2026 inventory pass surfaced: PASTE-01..03 (Python code, CSV, 400-word prose excerpt), IRREG-01..03 (swap-by-content, sort-by-date, multi-card move), STRUCT-01..03 (wrap_each, for_each_match, chained insert+set_attr).
- `benchmark/runners/model.mjs` instruments per-tool call counts so smoke runs can tell which tool the model picked per tag.
- `benchmark/models.json` typo fixes — gemini IDs corrected from `gemini-3-...` to `gemini-3.1-...`.

### What changed for testing

- `tests/e2e.mjs` test 63 updated for 3 tools (was hardcoded to 2).
- New tests **115a** (multi-op DSL plan: insert + set_attr round-trips through `modify()`, hist records single `edit_batch` with 2 compiled edits) and **115b** (DSL compile failure on non-unique anchor surfaces tool_result with code; model retries with corrected plan; succeeds). **274/274 e2e scenarios pass.**
- **42/42 conformance scenarios pass** against the modified seed.

### What changed for documentation

- `rwa-edit-dsl-spec.md` v0.1 — initial draft. §12 captures the production-runtime smoke results.
- `CLAUDE.md` updated: repository contents, rewrite-loop description (three tools), agent-contract section, three-site-alignment convention for DSL changes (spec ↔ runtime ↔ benchmark compiler).
- `README.md` mentions the DSL as part of the agent contract; adds `rwa-edit-dsl-spec.md` to the spec list.

### Backward compatibility

- **Strict addition.** `apply_edits` and `replace_document` envelope shapes and semantics are unchanged. Existing agents continue to work.
- **`rwa_hist` schema unchanged.** DSL plans flatten to `kind: 'edit_batch'`; consumers cannot distinguish whether an `edit_batch` came from `apply_edits` directly or from a compiled `apply_dsl_plan`.
- **No new IDB stores, OPFS paths, or HTML markers.** Reserved namespaces unchanged.
- **No CLI or service changes.** Both handle the seed bytes opaquely; no DSL-aware logic needed at those layers. The CLI's bundled `cli/seeds/rewritable.html` regenerates on the next `npm publish` from the canonical seed.

### Empirical observations (2026-05-05 production-runtime smoke)

Two real-model smoke runs against the modified seed via `ctx.modify` (89 scenarios, three tools available, model picks freely):

| metric | gemini-3.1-pro-preview | gemini-3.1-flash-lite-preview |
|---|---|---|
| Overall meanS | 1.73 | 1.57 |
| Overall meanT | 1.02 | 1.24 |
| `apply_dsl_plan` adoption (across all model calls) | **0.8 %** (2 / 244) | **~70 %** on structural; 0 % on content |

For comparison, the May 2026 apply_edits-only baselines: pro overall meanT=0.88, lite overall meanT=1.35.

Two findings the data forced:

- **Pro almost never picks `apply_dsl_plan`** when given the choice. The system prompt's "preferred for STRUCTURAL transforms" guidance is a nudge that the model overrides — most likely because str_replace-shaped tools dominate training data.
- **Most of pro's stability gain comes from the new prompt structure**, not from tool adoption. Paste meanT 0.22 → 1.78 on the same `apply_edits` path; structural_regular 1.27 → 1.76. The "render substantial paste verbatim" rule and the structural-vs-content split do the work.

Lite adopts the DSL freely but sees no net stability win (1.35 → 1.24 — slight regression). Lite was already byte-conservative on raw `apply_edits`; the DSL adds prompt-overhead and minor compile-down anchor widening without offsetting discipline gain.

The May 2026 forced-DSL ceiling (pro meanT=1.44) doesn't reproduce in production because pro doesn't adopt the tool. Full empirical writeup in `rwa-edit-dsl-spec.md` §12.

### Known limitations

- **Strong-model adoption is low.** Pro-class models override the prompt's preference and rarely pick `apply_dsl_plan` (~1 %). The architectural prediction "DSL ships → pro reaches meanT=1.44" was conditional on adoption that doesn't happen freely. Tightening the prompt or a runtime-level DSL-only mode could unlock it but neither is in v0.1.
- **The system prompt grew significantly.** Three tools, op schemas, and per-tool rules add ~1500 tokens to every modify request. Cost goes up modestly — flash-lite tok_in went 918 → 4402 on structural_regular. Acceptable for the fidelity gain but worth monitoring.
- **No DSL-only mode.** A runtime flag that disables `apply_edits` for structural intent would force agents into the DSL but isn't shipped. See `rwa-edit-dsl-spec.md` §12 for the open questions list.

## 2026-05-04 — CSV import (CLI + service)

`rwa import data.csv` and `rewritable.ikangai.com/import` accept CSV. The first row becomes `<thead>`, remaining rows `<tbody>`; every cell is HTML-escaped. Parses RFC 4180 — quoted commas, embedded newlines, escaped quotes, BOM — via PapaParse.

### What changed for users

- **`rwa import data.csv` is supported** by the CLI. Output is `<article><table>…</table></article>` wrapped in the seed.
- **`/import` accepts `.csv` alongside `.md`/`.markdown`** in the browser. Same drop zone, same flow.
- Parse warnings (e.g. malformed trailing quote) print to stderr (CLI) or are silently kept (browser, matching the CLI's "lenient" semantics — the result is still produced).

### What changed for the CLI

- `cli/src/import.mjs` gains `convertCsv()`. The `convert(ext, content)` switch grows a `case 'csv'` branch and the unsupported-format error message lists `.csv`.
- `cli/package.json` adds `papaparse@^5.4.1` (pinned to match cdnjs's latest, so the browser path can stay byte-equivalent).
- `cli/README.md` documents the CSV branch.

### What changed for the service

- `service/public/import.html` loads `papaparse@5.4.1` from cdnjs with a pinned **SRI hash** (`sha512-dfX5uYVXzyU8…`) alongside the existing pinned `marked`.
- `convertCsv` is a verbatim port of the CLI's; the file picker accepts `.csv,text/csv`; the handler dispatches on extension; the basename-stripping regex covers `.csv`.
- No new server-side code — the conversion stays in the browser.

### What changed for documentation

- `README.md` and `cli/README.md` mention CSV.
- `CLAUDE.md` extends the service conventions: `convertCsv` is now part of the CLI ↔ browser mirror, and the SRI-bump procedure covers both libraries.

### What changed for testing

- **Byte-equivalence test (load-bearing):** with the canonical seed, a stable `DOC_UUID`, and a fixture exercising RFC 4180 edge cases (quoted commas, embedded newlines, escaped quotes), `rwa import` and the browser-simulated `/import` produce byte-identical 37 422-byte outputs. A second fixture covering BOM + HTML-special chars in cells (`<script>`, `&amp;`, `<b>bold</b>`) also matches byte-for-byte at 37 347 bytes; cells are correctly HTML-escaped (no script can inject from a CSV cell).
- Manual: rebuilt the local Docker container, dropped both fixtures into `localhost:8083/import`, downloaded files opened in Chromium, table rendered, ⌘K still reached the agent.

### Backward compatibility

- Strict addition. Existing `rwa import .md/.html/.txt` paths are untouched.
- New CLI dependency: `papaparse`. `npm i -g rewritable` will pull it transitively; no opt-in needed.
- Bumping `papaparse` later requires recomputing the SRI hash and updating both `cli/package.json` and `service/public/import.html`; the procedure is documented in `CLAUDE.md`.

### Known limitations

- The imported `<table>` ships unstyled. The seed's stylesheet doesn't define table CSS, so a freshly imported CSV renders with default browser table styling against the dark body background — readable but plain. Users can prompt the agent (⌘K "make this table readable" / "add zebra striping") to style it. This matches how md tables behave on the existing path; adding default table CSS would be a separate decision affecting both paths.

## 2026-05-04 — `/import` endpoint: browser-side markdown import on the hosted service

The hosted service grows a sibling to `/new`. Visit `rewritable.ikangai.com/import`, drop a `.md` file, get back a re-writeable container with the markdown rendered into `INLINE_DOC` — no install, no upload.

### What changed for users

- **New page `/import`** (service). A drop zone + file picker that accepts `.md` / `.markdown`, converts client-side via `marked` (GFM enabled), and downloads a fresh container with a server-issued `DOC_UUID` and a filename-derived `<title>`.
- **`/new` carries a cross-link** to `/import`, and `/import` links back to `/new`. Both pages stay self-contained.
- **The file never leaves your machine.** Conversion runs in the browser; the server only serves the static page and the existing `/rewritable.html` (which already mints fresh UUIDs).

### What changed for the service

- `service/server.js` adds a single `/import` route (six-line addition) returning a static `service/public/import.html`. The `isHead` closure handles `HEAD /import` for free.
- `service/public/import.html` is a single self-contained page (~150 lines incl. styling). It loads `marked@14.1.4` from cdnjs with a pinned **SRI hash** (`sha512-oUb+v+OGnC4ls...`). The version is aligned with `cli/package.json`'s resolved `marked` so `/import` and `rwa import` produce byte-identical output.
- The conversion module ports three pieces of `cli/src/seed.mjs` and `commands.mjs` logic — `escapeTL` + LF canonicalization, the `INLINE_DOC` backtick-walk, and `<title>` / `FILE:` substitution. The CLI remains the source of truth; the browser is the mirror. **`DOC_UUID` substitution is not ported** — the server's `/rewritable.html` endpoint already substitutes a fresh UUID before the seed reaches the browser.
- Zero new server-side dependencies. No multipart parsing, no upload size limits, no `marked` on the server.
- `service/public/new.html` gains one anchor: `<p><a href="/import">import an existing markdown file instead</a></p>`.

### What changed for documentation

- `CLAUDE.md` grows a "Conventions when editing the service (`service/`)" section: the zero-dep rule, the keep-conversion-client-side rule, the import.html ↔ cli/src/seed.mjs mirror clause, and the SRI bump procedure.
- `docs/plans/2026-05-04-server-import-design.md` records the design (decisions, alternatives weighed, error surfaces, test strategy, future work for HTML/TXT/CSV).

### What changed for testing

- No new automated harness — the change is six lines of server route plumbing plus a static page. Verification is layered:
    - **Syntax checks:** `node --check` on `server.js`; `vm.createScript` on the inline browser script.
    - **Smoke tests** against a running server: `/health`, `/`, `/new`, `/import`, `HEAD /import`, `/rewritable.html`, and `/nonexistent` all return correct status, headers, and content.
    - **Byte-equivalence check (load-bearing):** with the canonical seed, a stable `DOC_UUID`, and a fixture markdown that exercises the gnarly cases (literal backticks, `${...}`, code blocks, blockquotes — the inputs that exercise `escapeTL`), `rwa import` and the browser-simulated `/import` produce byte-identical 37 529-byte outputs. This is the test that gates correctness; promoting it to an automated jsdom check is queued.
- Manual browser test: dropped a real `.md` into `localhost:8083/import` against the rebuilt Docker container; download fired, opening the resulting `.html` in Chromium showed the expected `<article>` and ⌘K reached the agent. The bootstrap is intact.

### Backward compatibility

- `/import` is a strict addition. `/new`, `/rewritable.html`, `/health`, and the `/` redirect are unchanged.
- No new environment variables, no migrations. Build → push → restart. Rollback = previous image.
- Bumping `marked` later requires recomputing the SRI hash and updating `import.html`; the procedure is documented in `CLAUDE.md`.

### Future work (not in this change)

- TXT import (trivial port of `convertTxt` from `cli/src/import.mjs`), then CSV import (new ground — the CLI doesn't support it), then HTML import (with a visible script-tag warning before download).
- Automated jsdom test that diffs `/import` browser output against `rwa import` for a fixture set.

## 2026-05-02 — hardening (low-priority sweep): popUndo, applySeedSubs, HEAD, comment-resilient HTML import, reserved IDs

A second pass at the LOW findings from the same bug hunt that produced the morning's HIGH/MEDIUM fixes. None of these are user-visible failures on the happy path; they tighten edge cases and defenses.

### What changed

- **`popUndo()` is now atomic** (seed). The read+write of `rwa_undo` runs in a single `readwrite` transaction, so two rapid `⌘Z` keypresses can no longer both observe the same array, both pop the same entry, and both write back the same shortened state. Previously: two presses, one undo. Now: two presses, two undos.
- **`applySeedSubs` validates `<title>` and `RWA.FILE` match counts** (CLI). Until now only `DOC_UUID` was guarded; a future seed regression that removes or duplicates the title/FILE site would have silently no-oped. All three substitution sites now enforce exactly-one-match-or-throw.
- **HEAD requests no longer return a body** (service). Per RFC 9110 §9.3.2. Refactored `send` into a per-request closure that observes `req.method === 'HEAD'` and ends the response with no body for HEAD.
- **`rwa import` of HTML survives comment-embedded `</head>`** (CLI). HTML comments are stripped before head/body extraction, so a literal `<!-- </head> -->` in the head no longer truncates the head match and let head-only content (e.g. `<style>`) leak into the body. Comments themselves are dropped — acceptable for an offline import; full preservation would require a real parser.
- **Reserved IDs cannot be introduced by `apply_edits` or `replace_document`** (seed). Both validators now reject any payload whose parsed DOM contains `#rwa-doc-mount` (the runtime's render mount, per CLAUDE.md "Reserved namespaces") or `[data-rwa-id]` (reserved for v2). Surfaces as `reserved_id_used` with the offending name in the structured payload.

### What changed for the seed

- New helper `findReservedIdViolation(parsedDoc)` returning the offending reserved name or null.
- `applyEdits` and `replaceDocument` call it after `parseHtmlFragment` and before `commitDoc`.
- `popUndo` rewritten as a single-transaction promise (no API change for callers).

### What changed for testing

- `tests/e2e.mjs` grows from 33 to 35 assertions:
    - **Test 12:** `replace_document` with `<div id="rwa-doc-mount">` is rejected; doc unchanged.
    - **Test 13:** `replace_document` with `[data-rwa-id]` is rejected; doc unchanged.
- The atomic `popUndo` and the HTTP HEAD fix are not exercised in the harness (concurrency-shaped and HTTP-shaped, respectively); both are verified by inspection and by smoke. The applySeedSubs and convertHtml fixes are smoke-tested via `rwa new` and `rwa import` against a fixture HTML containing `<!-- </head> -->`.

### Backward compatibility

- IDB shape unchanged; existing containers continue to work.
- `reserved_id_used` is a new failure code; no doc previously committed by the runtime would trip it (the doc-mount lives in the bootstrap, not in `INLINE_DOC`).
- The bootstrap byte-identity invariant still holds within this release across seed/hello.html/spec.html.

## 2026-05-02 — hardening: undo race, FSA stale handle, parallel tool_calls

Three correctness fixes on the rwa-edit/1 modify pathway, found by an autonomous bug-hunt over the runtime, CLI, service, and tests. All landed against the canonical seed and were regenerated into `hello.html` and `re-write-able-spec.html`. The container spec stays at v0.8 and the edit protocol stays at rwa-edit/1 (v1.4) — these are implementation corrections, not contract changes.

### What changed

- **`⌘Z` is now rejected while a `⌘K` is in flight** (HIGH). Previously, an undo pressed during the agent's fetch would `popUndo` and write `rwa_doc`, then `commitDoc` resolving inside `modify()` would clobber the doc and re-push the *pre-undo* doc onto the undo stack — silently destroying the user's revert and the popped state. `undo()` now checks `modifyMutex` and surfaces `✗ modify in progress`. The popped state is preserved for the next `⌘Z` once the modify completes.
- **Stale `FileSystemFileHandle` is purged on permission denial** (MEDIUM). When a saved handle's permission could not be regranted (file moved, access revoked, OS-level lockout), `commit()` fell through to a download blob — but left the dead handle in IDB, so every subsequent `⌘S` repeated the cycle and downloaded forever. The handle is now deleted from `rwa_<DOC_UUID>.rwa_fsa` on `permission !== 'granted'`, and the next `⌘S` re-prompts via `showSaveFilePicker`.
- **Parallel `tool_calls` no longer break retries** (MEDIUM). When the model emits two or more `tool_calls` in one assistant message, the runtime processes only the first. Previously, the failure feedback loop echoed the *full* `tool_calls` array back into the conversation but only emitted a `tool_result` for the consumed call — providers (OpenAI/OpenRouter spec) reject any assistant message whose `tool_calls` aren't all paired with `tool_results` on the next turn, so the next fetch returned HTTP 400 and the user saw a provider error instead of the structured rwa-edit retry. The runtime now echoes only `[tc]`.

### What changed for the seed

- New `idbDel` helper alongside `idbGet` / `idbPut`, scoped to a single read/write transaction.
- `undo()` gains the `modifyMutex` early-return guard.
- `commit()` calls `idbDel(RWA.FSA)` on the denied-permission branch and re-throws as `'permission denied — re-pick on next ⌘S'`.
- `modify()` retries push `tool_calls: [tc]` (the consumed one) instead of the full `toolCalls` array, in both the malformed-JSON and the `RwaEditError` branches.

### What changed for testing

- `tests/e2e.mjs` grows from 26 to 33 assertions. Two new scenarios:
    - **Test 10:** in-flight `⌘K` blocks `⌘Z`. Stubs `fetch` with a never-resolving promise, calls `modify()`, then awaits `undo()` and asserts the doc and the undo stack are unchanged. Resolves the fetch and asserts the modify completes cleanly.
    - **Test 11:** a model response with two parallel `tool_calls` triggers a retry that echoes only the consumed call. Asserts the retry assistant message has exactly one `tool_call` and that its id matches the consumed one.
- The FSA fix is *not* exercised in the harness: `FileSystemFileHandle` carries methods, and `fake-indexeddb`'s structured-clone roundtrip drops or rejects function-bearing values, so jsdom can't faithfully simulate the denied-permission path. The fix is verified by inspection; integration coverage requires a real Chromium harness.

### Backward compatibility

- Existing IDB state is unaffected. Containers committed with the morning's rwa-edit/1 bootstrap continue to work; their bootstrap upgrades only on the next `⌘S`.
- The bootstrap byte-identity invariant still holds: any container's bootstrap is byte-identical to any other (modulo `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body) within a release. Across the morning and afternoon releases of 2026-05-02, the bootstrap differs by ~12 lines.

## 2026-05-02 — rwa-edit/1 anchor-based modify pathway

The headline change: the agent now edits documents via **surgical anchor-based edits** instead of returning a fully rewritten document. Format drift across edits — the slow accumulation of model-driven whitespace, attribute reordering, comment removal, "improvements" to class names — is eliminated, because the model never re-emits the unchanged regions.

### What changed for users

- **`Cmd+K` is now a multi-turn tool-use conversation** (preferred model: any with strong tool-use; Claude Sonnet, GPT-4 family, Gemini Pro 1.5+). The agent submits `(find, replace)` pairs via the `apply_edits` tool. The runtime validates and commits atomically. On validation failure, the runtime feeds back a structured error and the model retries — up to 3 attempts per `Cmd+K`.
- **Wholesale rewrites still work**, via the `replace_document` escape hatch — used for scaffolding fresh documents or honoring explicit redesign requests. The runtime never falls back automatically; the model picks consciously.
- **New failure modes surface as status messages** in the palette and as structured payloads in the browser console:
    - `find_not_unique` — the model's anchor matched multiple places. Returned with occurrence count and surrounding-context snippets.
    - `frozen_zone_violation` — the edit tried to write reserved marker text or `data-rwa-frozen`.
    - `frozen_zone_corrupted` — author-declared frozen zones must be preserved byte-identically; this fires if any name or inner content changed, or a new zone was introduced.
    - `structural_shape_changed` — `<script>`/`<style>` tag counts must not change via `apply_edits`. Use `replace_document` for that.
    - `parse_error_post_apply` — the resulting doc didn't parse as valid HTML.
    - `replace_too_large` — a single replacement exceeds the 8 KB cap (nudges the model toward smaller edits).
    - `target_size_exceeded` — the resulting doc exceeds 1 MB.
    - `concurrent_modify` — a second `Cmd+K` while one is in flight is rejected immediately.

### What changed for document authors

- **Frozen zones are now a first-class feature.** Wrap any region in paired comment fences and the runtime refuses to modify the content between them — across both `apply_edits` and `replace_document`. Three forms:
    ```html
    <!-- rwa:frozen:begin invariants -->
    <meta name="schema-hash" content="b3a8...">
    <!-- rwa:frozen:end invariants -->
    ```
    ```css
    /* rwa:frozen:begin theme-tokens */
    :root { --accent: oklch(...); }
    /* rwa:frozen:end theme-tokens */
    ```
    ```js
    // rwa:frozen:begin api-contract
    window.runtime.shared.put('!tracker-tasks', tasks);
    // rwa:frozen:end api-contract
    ```
    Or mark a whole `<script>` / `<style>` element with `data-rwa-frozen`.

    Frozen zones can only be **added or removed by external editing of the container file**. The agent cannot introduce, alter, or delete them — that's the point.

- **LF-only line endings** are now an on-disk invariant. The runtime canonicalizes at read, validate, and commit time. CRLF input is normalized; the bootstrap captures itself LF-only at boot.

### What changed for the seed

- New constants and helpers in the bootstrap:
    - `canonLF`, `RWA_EDIT` (caps and reserved-marker list), `RwaEditError`.
    - Validator: `containsReservedMarker`, `countOccurrences`, `nearbySnippets`, `extractFrozenZones`, `frozenZonesIntact`, `parseHtmlFragment`, `computeShape`, `shapesEqual`, `dataRwaFrozenSnapshot`, `snapshotsEqual`.
    - `commitDoc` — single IDB transaction across `rwa_doc`, `rwa_undo`, `rwa_hist`. Replaces the v0.7 read-modify-write sequence that wasn't atomic.
    - `applyEdits`, `replaceDocument` — the validators-and-committers behind the two tools.
    - New `modify()` lifecycle: mutex → multi-turn tool conversation → validate → commit → re-render.
    - `TOOL_SCHEMAS`, new `SYSTEM_PROMPT` framing the agent as editor (not author).
- `rwa_hist` schema migrates from free-form prompt strings to typed records (`{ ts, kind, envelope }` for `edit_batch`; `{ ts, kind, reason }` for `replace_document`). Legacy entries coexist and cycle out within ~15 modifies.
- `escapeTL` LF-canonicalizes; FROZEN-bytes capture LF-canonicalizes.

### What changed for references

- `hello.html` and `re-write-able-spec.html` are now **regenerated from the seed**, inheriting the new bootstrap. Each preserves its own `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` content.

### What changed for the CLI

- `cli/src/seed.mjs`'s `escapeTL` mirrors the seed's LF canonicalization. Bumps `cli/package.json` to **v0.2.0** because freshly-emitted containers ship with the new modify pathway.

### What changed for documentation

- New `rwa-edit-spec.md` (v1.4) defines the edit protocol end to end: tool schemas, the multi-turn loop, frozen-zone enforcement, structural-shape preservation, atomic commit, audit log, failure modes, system prompt skeleton, validator pseudocode.
- `re-write-able-spec.md` (container spec) is unchanged at v0.8 — the bootstrap byte-identity invariant is preserved; only the contents of the modify pathway change.
- `CLAUDE.md` updated: editor-first agent contract, expanded reserved-namespaces list (now includes `rwa:frozen:*` markers, `data-rwa-frozen`, `data-rwa-id`, `#rwa-doc-mount`, and `rwa_hist` `kind` field), regenerate-from-seed convention for references.

### What changed for testing

- New `tests/` directory. `tests/e2e.mjs` is a 26-assertion harness that loads the seed in jsdom with `fake-indexeddb` and a stubbed `fetch`, drives `modify()` through every spec scenario, and verifies the resulting IDB state and DOM. Run with `(cd tests && npm install && npm test)`. The first regression test in this repo.

### Backward compatibility

- **Existing containers in IndexedDB are unaffected.** A container committed with the v0.7 single-shot bootstrap keeps using its own bootstrap until `Cmd+S` writes a new version. Nothing in the IDB schema changes.
- **`rwa new` and `rwa import` produce v1 containers.** A user who upgrades the CLI gets the new pathway in newly-emitted containers; their old containers continue to work as before.
- **The bootstrap byte-identity invariant holds.** The bootstrap of any v1 container is byte-identical to any other v1 container (modulo `DOC_UUID`, `RWA.FILE`, and `INLINE_DOC` body) — the v0.7 invariant is preserved.

## Earlier history

This is the first published changelog. Prior development is in the git log:

- 2026-04-* — `rwa` CLI (offline `rwa new` + `rwa import md/html/txt`), canonical `seeds/` layout, npm package renamed to `rewritable`.
- container spec v0.8 — preserve substantial pasted content; raise `max_tokens` to 32 000.
- container spec v0.7 — per-container UUID-namespaced IndexedDB, closing the cross-container shadowing footgun under `file://`.
- earlier drafts (v0.4 – v0.6) — the architecture got worked out the hard way.
