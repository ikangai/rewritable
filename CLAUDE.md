# CLAUDE.md

These rules apply to every task in this project unless explicitly overridden.
Bias: caution over speed on non-trivial work.

## Rule 1 — Think Before Coding
State assumptions explicitly. Ask rather than guess.
Push back when a simpler approach exists. Stop when confused.

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

## Rule 6 — Token budgets are not advisory
Per-task: 4,000 tokens. Per-session: 30,000 tokens.
If approaching budget, summarize and start fresh.
Surface the breach. Do not silently overrun.

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

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository contents

- `re-write-able-spec.md` — canonical container spec (source of truth, currently v0.10 — "public runtime API pass": §7 specifies the `window.runtime` surface — `id`, `db.*`, `fs.*`, `modify`/`commit`/`undo`, `status`, `on` — wired through the seed; OPFS gains per-container `_<DOC_UUID>/` namespacing; `runtime.shared.*` remains deferred to §11.5)
- `rwa-edit-spec.md` — **rwa-edit/1 anchor-based edit protocol** (currently v1.4). Defines how the agent expresses changes via `apply_edits` / `replace_document` tool calls instead of wholesale document rewrites.
- `rwa-edit-dsl-spec.md` — **rwa-edit-dsl/1 structural transform DSL** (currently v0.1, shipped 2026-05-05). Sugar on top of rwa-edit/1: a small fixed vocabulary (`replace`, `insert`, `delete`, `set_attr`, plus `replace_document` escape) that the runtime compiles deterministically to `apply_edits` envelopes. Surfaced as the `apply_dsl_plan` tool. Empirically: when *forced* to emit DSL, gemini-3.1-pro-preview reached meanT=1.44 (vs apply_edits-only's 0.88). Through the production runtime (3 tools, model picks), pro adopts `apply_dsl_plan` ~1 % of the time and lands at meanT≈1.02; flash-lite picks it ~70 % of the time on structural transforms but its overall meanT moves slightly the wrong way (1.35 → 1.24). Most of pro's actual stability gain comes from the new system prompt structure (paste-verbatim rule, structural-vs-content split), not from tool adoption. See `rwa-edit-dsl-spec.md` §12 for the full empirical writeup.
- `docs/specs/rwa-lens-spec.md` — **rwa-lens/1 edit-model spec** (currently v0.9, shipped 2026-05-09). Defines the user-surface layer that replaces the modal `⌘K` with a single steerable input — the *lens* — that has two states (default, anchored) and discriminates content from instruction via a leading slash. Every gesture compiles to an existing rwa-edit/1 envelope; no new edit protocol. Class-declared locks (`class="rwa-locked"`) extend frozen-zone enforcement: rejected at anchor; overlap-checked for `apply_edits`/`apply_dsl_plan`; `replace_document` rejected unless the lock is entirely contained within a marker-form frozen zone. Implementation plan at `docs/plans/2026-05-09-lens-edit-model.md`.
- `docs/specs/re-write-able-actions-spec-v0.7.md` — **action/skill/permission-layer spec** (cluster pass v0.7, canonical). Specifies the layer that sits *above* the substrate: the install dialog as the design driver (§1), the `.rwa-skill.json` share format with Ed25519 source identity and lookalike detection (§2 / §11.9), the permission grammar across `network:` / `vault:` / `fsa:` / `bus:` / `idb:` tiers with anti-escalation by construction and recognizable-combinations curation (§3 / §11.10), and the full Worker-mode design — in-Worker global shadowing, host CSP, message-channel identity tags, 1.5s shutdown / 5-min idle pool lifecycle, forced-Worker policy on credential×network and adjacent combinations (§4 / §11.12). The spec is independent of the substrate runtime in `seeds/rewritable.html` — none of v0.7's surfaces are implemented in the substrate yet; the spec defines the contract. Audit context at `docs/runtime-product-agnosticism-audit.md` (R6/R7 re-grades reflect this spec).
- `docs/specs/re-write-able-actions-spec{.md,-v0.2.md,-v0.3.md,-v0.4.md,-v0.5.md,-v0.6.md,-v0.6.1-patch.md}` — **action-layer drafting lineage** (v0.1 origin → v0.6.1 patch, all in-repo as of 2026-05-18). The unprefixed `re-write-able-actions-spec.md` is v0.1 (broad framing — vault, skills, workflows, fork-on-share, "the server is convenience, not custody"); v0.2 closed the structural issues from the v0.1 review (vault scope, graph editing protocol, installation as privileged op); v0.3 committed the by-trigger persistence boundary + calling-skill identity; v0.4 landed the defense-in-depth proxies story (the §2.4 reference v0.7 §6.1 leans on); v0.5 pinned Worker pre-selection for imports + `tested_modes`; v0.6 collapsed the trusted-vs-untrusted import distinction + committed reject-with-message; v0.6.1-patch fixed five issues (Worker pool reset, pool lifetime, composition audit, in-edit timeout disambiguation, forced-Worker × tested_modes). Read-only drafting history — edits to the action layer go in v0.7 (or a future v0.8 if a substantive revision is needed).
- `docs/specs/re-write-able-actions-spec-v0.7-working-method{.md,-addendum.md,-addendum-patch.md,-addendum-patch-r2.md}` — **working-method companion** for v0.7 (preamble + addendum + addendum patch r1 + addendum patch r2). Documents the dialog-first design method behind v0.7's cluster pass: install dialog as a co-constraint on the architecture, not a downstream consumer; cluster scope; the named attack shapes (A–E) the cluster decides for/against. Referenced by v0.7's opening summary. Read-only.
- `docs/specs/rwa-product-types.md` — **product-type taxonomy via the layer-cake** (draft v0.1, shipped 2026-05-18; workflow re-layered to substrate 2026-05-19). Names the three architectural layers (substrate → graph → skill) and maps the four product types (document, app, workflow, multi-agent workspace) onto them. Documents, apps, and v0.4 workflows live at substrate; multi-stage workflows (per-item state machines) remain deferred to a `rwa-graph/1` layer; multi-agent workspaces live at skill (`re-write-able-actions-spec-v0.7.md`). Used as the lens for product-agnosticism discussions; the runtime audit references it.
- `docs/specs/rwa-workflow-spec.md` — **workflow product shape spec** (v0.4, shipped 2026-05-19). First canonical reference for the workflow product. Defines three composable primitives — linear `<li class="rwa-step">`, foreach `<li class="rwa-step rwa-foreach">` with nested `<ol class="rwa-flow">`, and parallel `<table class="rwa-parallel">` with `<td class="rwa-step" data-rwa-label="...">` cells. Specifies the data flow contracts (`prev` threading, `ctx.iter = {index, item, total}` inside foreach, `Promise.all` semantics for parallel), the `ctx` object surface, per-step state attributes (v0.3 leaf-only carryover), error codes (`foreach_upstream_not_array`, `parallel_label_invalid`, `step_missing_script`, `pinned_value_invalid_json`), and an informative runner contract. Multi-row parallel, per-cell failure containment, inter-cell comms, container-level pin, dynamic parallelism are all v0.5+. Reference implementation lives in `cli/src/seed.mjs`'s `KIND_WORKFLOW_BODY` frozen runner block. Conformance: `benchmark/scenarios/conformance/workflow-{01..10}.mjs`.
- `docs/runtime-product-agnosticism-audit.md` — read-only audit (2026-05-18) of substrate-layer product-agnosticism with file:line citations and ten ranked recommendations. The 2026-05-18 addendum re-grades R6/R7/§3(4) against the actions spec and reframes the whole audit around the layer-cake. Working document, not a spec.
- `re-write-able-spec.html` — worked-example reference: the spec itself rendered as a re-writeable document. Bootstrap regenerated from `seeds/rewritable.html`.
- `hello.html` — minimal base variant: a one-line "hello world" wrapped in the canonical bootstrap. Bootstrap regenerated from `seeds/rewritable.html`.
- `seeds/rewritable.html` — **canonical bootstrap seed**. Hosts the DSL compiler inline (`compileDslPlan` + helpers, just before the modify lifecycle). Both the service and the CLI read this to emit fresh containers. Has a nil-UUID sentinel that is substituted at emit time.
- `service/` — Node HTTP service that serves the landing page at `/` (see `service/public/landing.html`), hands out fresh containers via `/new`, converts user-supplied documents into a container via `/import` (browser-side conversion against the same seed endpoint; supports md/csv/docx/pdf), hosts published-snapshot shares via `POST /publish` → host-keyed `<short>.rewritable.ikangai.com/` URLs (anonymous, 24h expiry, 10 publishes/hour per IP, 25 MB body cap; legacy `/s/<short>` paths 301-redirect to the host-keyed form), and serves the agent-facing rewritable-building skill bundle via `GET /skill.zip` (SKILL.md + INLINE_DOC body examples). Build context is the **repo root** (so it can `COPY seeds/`); see `service/Dockerfile` and `service/docker-compose*.yml`. Snapshot storage lives in `service/data/` (named volume `rwa_shares` in prod, bind-mounted `./data` in dev) — operator-readable, never in version control.
- `cli/` — `rwa` npm package (the CLI). `rwa new` emits a fresh container; `rwa import <file>` converts md/html/txt/csv/docx/pdf into one. Reads the canonical seed in dev; ships its own bundled copy on `npm publish` via the `prepublishOnly` hook.
- `tests/` — end-to-end harness for the rwa-edit/1 modify pathway. Loads the seed in jsdom with stubbed fetch + fake-indexeddb and exercises every scenario in `rwa-edit-spec.md` plus the apply_dsl_plan dispatch tests (115a/b). Run via `cd tests && npm install && npm test`.
- `benchmark/` — fidelity + conformance harness. `npm run conformance` runs 42 deterministic conformance scenarios against the seed; `npm run fidelity:stub` runs 89 scenarios against hand-coded stubs; `npm run fidelity:dsl` validates the DSL compile-down round-trip (12 expressible scenarios — apply both stub and compiled envelopes, compare final docs). Real-model paths: `node runners/run-fidelity.mjs <model>` (default apply_edits), `... <model> dsl` (DSL plan mode), `... hybrid-tag hybrid` (supervisor + workers; reads `RWA_HYBRID_SUPERVISOR` / `RWA_HYBRID_STRUCTURAL` / `RWA_HYBRID_CONTENT` from env).
- `README.md` — short pitch

The references and seed have no build step — "run" = open the `.html` in a browser, "test" = open the `.html` in a browser. The CLI has a `package.json` with four runtime deps (`marked`, `papaparse`, `mammoth`, `pdfjs-dist`) — one per non-trivial import format. The `tests/` package is dev-only (jsdom + fake-indexeddb) and is not part of any shipped artifact. There is no lint config at the repository level.

If the user asks you to update the container spec, edit `re-write-able-spec.md` and treat the `.html` rendering as derived (regenerate or note drift).

If the user asks you to update the edit protocol, edit `rwa-edit-spec.md` (versioned `rwa-edit/N`).

If the user asks you to update the structural-transform DSL, edit `rwa-edit-dsl-spec.md` (versioned `rwa-edit-dsl/N`) AND mirror the change in the inline `compileDslPlan` block in `seeds/rewritable.html` AND in `benchmark/oracles/dsl-compiler.mjs` (the offline round-trip test). Three sites must stay aligned: spec, runtime, benchmark compiler.

If the user asks you to update the lens edit model, edit `docs/specs/rwa-lens-spec.md` (versioned `rwa-lens/N`) AND mirror behavior changes into `seeds/rewritable.html` (the lens cluster: source-position map, anchored/default dispatchers, click-to-anchor, locked-region checks, history schema). After any seed change, regenerate `hello.html` and `re-write-able-spec.html` via `node tools/regenerate-refs.mjs`.

If the user asks you to update the action / skill / permission / Worker-mode layer, edit `docs/specs/re-write-able-actions-spec-v0.7.md`. The spec is sectioned by cluster (§11.9 provenance / `.rwa-skill.json`, §11.10 permission grammar, §11.12 Worker-mode) — preserve that structure. The spec is independent of the substrate; runtime changes are downstream implementations. The earlier drafts (v0.1 / v0.2 / v0.3 / v0.4 / v0.5 / v0.6 / v0.6.1-patch) are read-only drafting history — don't modify them. The v0.7 working-method companions (preamble + addendum + two patches) are also read-only. If a substantive revision beyond v0.7's scope is needed, bump to v0.8. One v0.7 cross-reference imprecision worth fixing on the next pass: §5.3 says "the v0.10 main spec's lens-lock semantics," but the lens-lock content actually lives at `rwa-edit-spec.md` §5.5 (modify mutex source-of-truth) plus `docs/specs/rwa-lens-spec.md` (lens UI reflection of the mutex) — the behavior is documented; only the cross-reference points at the wrong file.

If the user asks you to update the product-type taxonomy or the layer-cake framing, edit `docs/specs/rwa-product-types.md`. Keep it short — the file's job is to name the three layers (substrate / graph / skill) and route to the spec that owns each. Don't restate spec content; link to it.

If the user asks you to update the workflow product shape (linear / foreach / parallel primitives, `ctx.iter`, `data-rwa-label`, error codes, etc.), edit `docs/specs/rwa-workflow-spec.md` AND mirror runtime changes into `cli/src/seed.mjs`'s `KIND_WORKFLOW_BODY` (CSS + frozen runner block) AND update `SYSTEM_PROMPTS.workflow` in `seeds/rewritable.html` if the change affects what the agent emits. Three sites must stay aligned: spec, runner, prompt. After any seed change, regenerate `hello.html` and `re-write-able-spec.html` via `node tools/regenerate-refs.mjs`. Conformance scenarios under `benchmark/scenarios/conformance/workflow-*.mjs` exercise the spec; add new ones when extending the primitives.

If the user asks you to update the bootstrap, edit `seeds/rewritable.html` (the canonical copy). `hello.html` and `re-write-able-spec.html` carry their own `DOC_UUID` and `INLINE_DOC` content but their bootstrap should mirror the seed — regenerate by substituting `DOC_UUID`, `FILE`, and `INLINE_DOC` body into the seed. As of audit R1, `SYSTEM_PROMPT` is no longer a single constant: it resolves at module load via `SYSTEM_PROMPTS[PRODUCT_KIND] || SYSTEM_PROMPTS.document`. The registry holds per-kind framing (one entry per product kind); a shared `SYSTEM_PROMPT_RULES` block carries the tool rules, DSL syntax, frozen-zone rules, and data-rwa-id guidance. Each kind's prompt must match `rwa-edit-spec.md` §8/§9.1 (apply_edits, replace_document) AND `rwa-edit-dsl-spec.md` §3/§4 (apply_dsl_plan); `SYSTEM_PROMPT_RULES` is the one source of truth so a tool-rule change lands across all kinds. `TOOL_SCHEMAS` remain a single constant since they encode wire-format shape (not framing). As of audit R2, `rwa_hist` records may carry an optional `actor` field — free-form string identifying the agent or surface that produced the commit (the active model id for command paths; `user:lens` for direct-text paths; `bridge:claude-p` for the bridge transport). Pre-R2 records without `actor` continue to render correctly in the history pane (single chip, no second chip).

## What re-write-able is (architecture in one page)

**Three architectural layers, stacked.** The substrate (this seed + bootstrap) renders, edits, commits, and exports the document — that is what this section describes. Above the substrate is the **graph layer** (`rwa-graph/1`, deferred spec): multi-stage workflows where items move through lanes with durable per-item state. Above that is the **skill layer** (`docs/specs/re-write-able-actions-spec-v0.7.md`): permission-gated skills with vault, bus, install-time dialog, and Worker-mode isolation. The four product types map onto these layers — document, app, and v0.4 workflows (tree-of-steps) at substrate; multi-stage workflows at graph; multi-agent workspaces at skill (see `docs/specs/rwa-product-types.md`). Everything below in this section is substrate-layer; the higher layers operate on top of it.

A re-writeable file is a single self-contained `.html` that renders, stores, modifies, and exports itself with no server. The file ships with three pieces inside one `<script id="rwa-bootstrap">` block:

```
container.html
├── DOC_UUID            — per-container UUID, baked at creation
├── INLINE_DOC          — frozen snapshot of the document (template literal)
└── runtime + loader    — IDB helpers, FSA commit, ⌘K/⌘Z/⌘S, agent call
```

The bootstrap is immutable. **Only the contents of the `INLINE_DOC` template literal change between commits.** `DOC_UUID`, the loader, and the runtime bytes are byte-identical from open to commit to next open.

### The rewrite loop (rwa-edit/1)

`⌘K` → acquire modify mutex → read current doc from IDB (LF-canonical) → call agent with `apply_dsl_plan`, `apply_edits`, and `replace_document` tools (multi-turn tool-use loop, retry budget 3) → on a successful tool call: validate, then atomically commit `(rwa_doc, rwa_undo, rwa_hist)` in a single IDB transaction → re-render → release mutex.

`⌘Z` pops `rwa_undo`. `⌘S` rebuilds the file (FROZEN bytes + `escapeForTL(currentDoc)` between the INLINE_DOC backticks) and writes it: in-place via FSA on Chromium, downloaded blob otherwise. The agent never sees the bootstrap — only the document.

The agent emits **edits, not documents**:

- `apply_dsl_plan` is preferred for **structural** transforms. It carries a sequence of typed ops (`replace`, `insert`, `delete`, `set_attr`, plus `replace_document` escape). The runtime compiles the plan to an `apply_edits` envelope deterministically (or, for the escape op, `replace_document`); compile errors flow through the existing failure → tool_result → retry loop. Spec: `rwa-edit-dsl-spec.md`.
- `apply_edits` is preferred for **content** transforms. It carries `(find, replace)` pairs that anchor on unique substrings. The runtime applies them as exact string substitutions, so unchanged regions are byte-identical.
- `replace_document` is the escape hatch for scaffolding or wholesale redesigns. The runtime never auto-falls back from `apply_edits` (or DSL) to `replace_document` after retry exhaustion — silent escalation would defeat format stability.

The DSL ships in the runtime as of 2026-05-05. Both rwa-edit/1 (apply_edits) and rwa-edit-dsl/1 commit through the same audit log: every successful tool call lands as a `kind: 'edit_batch'` record in `rwa_hist` (DSL plans flatten to their compiled apply_edits form), or `kind: 'replace_document'` for wholesale rewrites.

### Per-container IndexedDB (the v0.7 invariant)

Every container's private IndexedDB lives under `rwa_<DOC_UUID>` — *not* the shared `rwa` database. Earlier drafts (v0.4–v0.6) used a single `rwa` DB for all containers, which under `file://` (null origin) made every container shadow whichever one last committed. v0.7 closes this by namespacing the database with the build-time UUID.

| Tier | Where | Holds |
|---|---|---|
| **Per-container IDB** (`rwa_<DOC_UUID>`) | private | `rwa_doc`, `rwa_undo`, `rwa_hist`, `rwa_fsa`, plus document-defined stores |
| **Shared IDB** (`rwa_shared`) | opt-in | `runtime.shared.*` — composition surface for cross-container reads/writes (spec §5.7, §11.5) |
| **OPFS** (`_<DOC_UUID>/`) | per-container, in the shared null origin | binary blobs (via `runtime.fs.*`) |
| **sessionStorage** | per tab | API key + backend choice + per-backend base-URL overrides + model name — never persisted |
| **Filesystem** | the container itself | bootstrap with current `INLINE_DOC` |

**Reserved namespaces** — runtime owns these; documents must not write them directly:
- IDB databases: `rwa_<DOC_UUID>`, `rwa_shared`
- IDB stores within `rwa_<DOC_UUID>`: anything matching `rwa_*`
- IDB record `kind` field within `rwa_hist`: `"edit_batch"`, `"replace_document"` (rwa-edit/1; DSL plans flatten to `edit_batch`)
- OPFS paths: `_rwa/`
- HTML element ID: `#rwa-doc-mount` (the render mount)
- Comment prefix substrings inside the doc: `<!-- rwa:`, `/* rwa:`, `// rwa:` and the marker forms `rwa:frozen:begin <name>` / `rwa:frozen:end <name>` (rwa-edit/1, see `rwa-edit-spec.md` §15)
- HTML attributes: `data-rwa-frozen` (inline frozen-zone declaration); `data-rwa-id` (runtime-assigned stable block identifier — bootstrap 0.9 backfills it on every anchorable block at boot and at every commit, skipping frozen zones; the agent must preserve existing values verbatim; spec §5.9)

**The bootstrap is the anchor.** It is never in IndexedDB and never visible to the agent. If something goes wrong, reload the file — the inline snapshot is the last known good state, and the runtime can be reset by deleting the container's IDB (`rwa_<DOC_UUID>`).

### Agent contract

System prompt is **editor-first** (not author-first): the agent applies surgical edits to an existing document, not a fresh rewrite. The agent has three tools:

- `apply_dsl_plan` — preferred for structural transforms. Submits a sequence of typed ops; the runtime compiles to `apply_edits` deterministically.
- `apply_edits` — preferred for content transforms. Submits `(find, replace)` pairs with literal, unique anchors.
- `replace_document` — escape hatch. Submits the entire new doc with a required `reason`.

The runtime drives a **multi-turn tool-use conversation**: on tool-call failure (`find_not_found`, `find_not_unique`, `frozen_zone_violation`, `structural_shape_changed`, etc.), the runtime feeds the structured failure back as a `tool_result` and the model gets another attempt — up to 3. After exhaustion, the user sees the failure code and helper context; no silent escalation.

The agent receives only the document (LF-canonical text that lives inside `#rwa-doc-mount`) and the list of frozen-zone names; the bootstrap, runtime, and inline snapshot are not in the prompt. The agent must not produce reserved marker substrings (`rwa:frozen:begin`, `rwa:frozen:end`, the rwa: comment prefixes, `data-rwa-frozen`) in `find` or `replace`. **Frozen zones are author-declared invariants**: changing them requires external editing of the container file.

### Agent backends

The runtime supports four backends, picked in the settings panel. All four route through the same `modify()` lifecycle — the differences are only in how the chat completion is delivered:

| Backend | Transport | Multi-turn tool-use? | Setup |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1/chat/completions` with `Bearer <key>` | yes | API key in settings |
| `ollama` | `http://localhost:11434/v1/chat/completions` (override-able) | yes | start `ollama serve` with `OLLAMA_ORIGINS=*` |
| `lmstudio` | `http://localhost:1234/v1/chat/completions` (override-able) | yes | enable CORS in LM Studio's Developer tab |
| `bridge` | `POST http://127.0.0.1:8765/run` shelling out to `claude -p` | no (single-shot envelope) | run web_cli_bridge locally |

`openrouter`, `ollama`, and `lmstudio` are the **same OpenAI-compatible transport** routed through `resolveBackendConfig()` → `openAiCompatChat()`. They all participate in the multi-turn tool-use loop (3 retries on `apply_dsl_plan` / `apply_edits` / `replace_document` failure). The base URL for `ollama` and `lmstudio` is overridable in settings (per-backend sessionStorage keys `rwa_base_url_ollama` / `rwa_base_url_lmstudio`); the override lets advanced users point at any OpenAI-compatible server (vLLM, Jan, llama.cpp's server, etc.) but the named backends carry the matching CORS-setup hint inline in the settings panel. The settings panel has a "Test" button that probes `GET <baseUrl>/models` — on success it populates a `<datalist>` so the model input gets autocomplete from the live server; the most common first-run failure is CORS, and the button labels it as such.

`bridge` is a separate transport (the `web_cli_bridge` localhost shim) and runs single-shot: `claude -p` has no mid-stream tool_calls, so the runtime instructs the model to emit one of the rwa-edit/1 envelopes as plain text and dispatches it through the same apply* machinery.

Default model: `google/gemini-3-flash-preview` (OpenRouter). For local backends, the model is picked from the running server's installed list. Tool-use quality varies by model — for difficult edits, switch to a strong tool-using model (Claude Sonnet, GPT-4, or a tool-capable local model like Llama 3.1, Qwen 2.5 Coder, or Mistral Nemo).

### Commit (`⌘S`)

```js
buildFile(currentDoc) =
  FROZEN.slice(0, after_INLINE_DOC_backtick) +
  escapeForTL(currentDoc) +
  FROZEN.slice(closing_INLINE_DOC_backtick);
```

`escapeForTL` escapes `\`, `` ` ``, `${`, and `</script` so the document is safe to re-embed in the template literal. The closing-backtick locator walks the literal honoring backslash escapes.

FSA persistence: the `FileSystemFileHandle` is structured-cloneable in modern Chromium, so it lives in `rwa_<DOC_UUID>.rwa_fsa` and is reused across sessions. Permission can lapse (`prompt`/`denied`/`lost`) — fall back to download mode and surface a regrant affordance.

### Design constraints for documents

- Single self-contained file; CSS inline; JS inline only when the document has interactivity.
- No React, no npm, no build steps. Libraries from `cdnjs.cloudflare.com` only when genuinely needed.
- Light theme palette (playground.ikangai.com-aligned, since 2026-05-13): neutral grayscale ramp `--gray-50…--gray-900` (`#fafafa` → `#171717`) plus semantic `--green:#22c55e` / `--yellow:#eab308` / `--red:#ef4444` / `--blue:#3b82f6`. Legacy aliases (`--bg`, `--surf`, `--b1`/`--b2`, `--text`, `--muted`, `--accent`) resolve to the ramp so existing INLINE_DOC references keep rendering. Primary action color is `--gray-900` (the ⌘S commit button and "command mode" lens border). The lens chrome is a floating max-width 680px white card with `--radius` (24px), a 1px `--gray-200` border, and shadows `0 2px 8px rgba(0,0,0,.04)` baseline → `0 4px 16px rgba(0,0,0,.08)` on `:focus-within`. Docked at `bottom:24px`; `body` has `padding-bottom:160px` so document content scrolls above it.
- Baseline content typography (since 2026-05-18): the seed bootstrap styles `:where(#rwa-doc-mount) article, h1…h6, p, ul/ol, blockquote, pre, code, hr, table, img, figure, kbd` with a clean system-font default. Wrapped in `:where()` so specificity is 0 — any `<style>` block inside INLINE_DOC always wins. `article` defaults to `max-width:720px; margin:64px auto; padding:0 32px;` so every document gets page-like margins without opting in. Imports (md/csv/docx/pdf) and agent-written content inherit this for free.
- Print stylesheet (since 2026-05-18): the seed ships `@page { margin:18mm; }` plus a `@media print` block that hides `#rwa-runtime`, collapses the baseline article padding (so `@page` owns the paper margin), and applies break-control (`break-after:avoid` on headings, `break-inside:avoid` on figure/pre/blockquote/table/tr/li/img, `orphans:3;widows:3` on paragraphs). Link color is forced black for monochrome printers; `print-color-adjust:exact` is set so document-defined colors survive. The blank starter doc's `.placeholder` paragraph is hidden under `@media print` so an unwritten doc prints as a clean page with just the heading.
- Fonts: system stack — `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` for UI; `'SF Mono', Menlo, Monaco, ui-monospace, 'Cascadia Mono', monospace` for code/labels. Exposed as `--font-ui` and `--font-mono`. No web fonts loaded; the bootstrap is fully self-contained.
- Real seed data, never lorem ipsum.
- Pure-prose documents are valid: a single `<article>` and a stylesheet, no JS.

### Platform reality

iOS Safari evicts IndexedDB aggressively after inactivity or storage pressure. The `navigator.storage.persist()` request and the dirty-state nudge after uncommitted modifications exist because of this. **The exported `.html` on disk is the only durable artifact** — every runtime change should preserve or strengthen that escape hatch. Private/incognito is explicitly unsupported; detect and message clearly.

## Conventions when editing the spec

- The spec is versioned in its closing line (`Spec version 0.8 — ...`). Bump it on material changes and update the trailing summary to describe what changed.
- Cross-references use `§N.M` (e.g. `§5.3`); preserve numbering when reorganizing.
- Load-bearing invariants (listed in the spec's "Invariants" section): the bootstrap is byte-identical except for `INLINE_DOC` contents; each container has its own UUID and IDB; the runtime is never in IDB and never visible to the agent; reserved stores are runtime-only; commits do not carry undo state. Flag any proposed change to these explicitly.

## Conventions when editing the references

- `hello.html` and `re-write-able-spec.html` share their bootstrap with `seeds/rewritable.html`. The standard update flow is **regenerate from the seed**: read the reference's existing `DOC_UUID` and `INLINE_DOC` content, copy the seed wholesale, then substitute `DOC_UUID`, `RWA.FILE`, and the `INLINE_DOC` body back in.
- Each reference ships with its own `DOC_UUID`. Never reuse a UUID across files. Generate fresh: `node -e 'console.log(crypto.randomUUID())'`.
- The agent's system prompt and tool schemas live in the bootstrap (`SYSTEM_PROMPT`, `TOOL_SCHEMAS`). They must match `rwa-edit-spec.md` §8 and §9.1 (apply_edits, replace_document) AND `rwa-edit-dsl-spec.md` §3 and §4 (apply_dsl_plan ops + JSON shape).

## Conventions when editing the CLI (`cli/`)

- The CLI is offline-first. `rwa new` and `rwa import` must work without network. Don't add anything that fetches the seed at runtime.
- The seed is loaded by the CLI from a small candidate list: `cli/seeds/rewritable.html` (the in-package copy that prepublish creates) preferred; `seeds/rewritable.html` (canonical, dev mode) as fallback. Don't add more candidates without thinking about how the search semantics interact with `npm publish`.
- The CLI mirrors three pieces of bootstrap-side logic: `escapeTL` (the template-literal escape), the INLINE_DOC backtick-walk, and the DOC_UUID substitution regex. If any of those change in `seeds/rewritable.html`, mirror the change in `cli/src/seed.mjs`.
- Product-kind machinery (added 2026-05-18 across R9-minimal, v0.1.1, R1, and R3-scoped). `rwa new --kind <name>` substitutes six regions in the seed at emit time via `kindOverrides(kind)` in `cli/src/seed.mjs`: (1) `INLINE_DOC` body, (2) the `LENS_PLACEHOLDER` const, (3) the `LEGACY_PAL_PLACEHOLDER` const, (4) the `PRODUCT HEADER` comment block, (5) the `PRODUCT_KIND` const (audit R1 — selects the active entry in `SYSTEM_PROMPTS`), (6) the `LENS_CLICK_TO_ANCHOR` boolean (audit R3 scoped — false for kinds where every block is anchorable, e.g. workflow). Known kinds: `document` (default), `workflow`. Adding a kind = one entry in `KIND_TABLE` (`cli/src/seed.mjs`) carrying body/lens/pal/header/kind/clickToAnchor values, plus a new entry in the seed's `SYSTEM_PROMPTS` registry (per-kind framing), plus a line in `cli/README.md` and the help text in `cli/bin/rwa.mjs`. Substitution regexes anchor on stable const declarations and marker pairs; `applySeedSubs` enforces exactly-one match per region so a seed-side rename can't silently no-op.
- Workflow v0.3 — iteration tightening (added 2026-05-19, n8n-inspired pin / dirty / test-step). `KIND_WORKFLOW_BODY`'s frozen runner block carries three per-step affordances exposed via three `<li class="rwa-step">` data attributes: `data-pinned-output` (JSON; runner short-circuits `run()` and threads this value forward), `data-last-output` (JSON; cached for the per-step ▶ Test button), `data-last-run-hash` (8-char FNV-1a hex of `stepBody + prevHash` at last successful run; mismatch ⇒ `.stale` class on render). The pin gesture (📌) commits via `runtime.applyEnvelope` and snapshots the live `<li>`'s runner attrs so the audit-log commit preserves them across the IDB replay. The test gesture (▶) runs JUST that step against the upstream's cached/pinned value — no whole-workflow run. All state lives inside `INLINE_DOC`, so ⌘S preserves it; the agent's `apply_edits` envelopes must preserve these three attributes verbatim (system prompt rule). Conformance scenarios: `benchmark/scenarios/conformance/workflow-{03,04,05}.mjs`. Plan + rationale at `docs/plans/2026-05-19-workflow-v0.3-iteration-tightening.md`.
- Workflow v0.4 — concurrency & iteration (added 2026-05-19). The frozen runner is now a recursive tree-walker dispatching on three node types: linear `<li class="rwa-step">`, foreach `<li class="rwa-step rwa-foreach">` (whose nested `<ol class="rwa-flow">` is the loop body), and parallel `<table class="rwa-parallel">` (one `<tr>` of `<td class="rwa-step" data-rwa-label="...">` cells run via `Promise.all`). Foreach exposes `ctx.iter = {index, item, total, parent}` to every inner step; parallel cells share the same upstream `prev` and produce an object keyed by `data-rwa-label`. Errors with stable codes: `foreach_upstream_not_array`, `parallel_label_invalid` (regex `/^[a-z][a-z0-9_]{0,31}$/`, uniqueness within row), `step_missing_script`, `pinned_value_invalid_json`. v0.3 leaf affordances extend cleanly: drag-reorder scoped to top-level `<li.rwa-step>`, delete works on any step node, toolbar (▶ test, 📌 pin) attaches to all leaves including `<td class="rwa-step">`, insert buttons appear in every `<ol class="rwa-flow">` (top-level + foreach bodies). `findStepInDoc` upgraded to match both `<li>` and `<td>` regardless of attribute order. CSS: dashed left border on foreach, iteration counter chip during run, parallel table with per-cell label chips and mobile reflow. Conformance scenarios: `benchmark/scenarios/conformance/workflow-{06,07,08,09,10}.mjs`. Spec: `docs/specs/rwa-workflow-spec.md`. Plan + rationale: `docs/plans/2026-05-19-workflow-v0.4-concurrency-and-iteration.md`.
- Workflow v0.6 — per-cell `data-allow-failure` (added 2026-05-19). A parallel cell can opt into failure containment with `data-allow-failure="true"`. When it throws, the parallel block does NOT halt: that cell's slot in the output object becomes `{ __error: "<message>", __code: "<code or null>" }`; sibling cells and downstream continue. Without the attribute, default fail-fast semantics still apply. Implementation: `runParallel` switched from `Promise.all` to `Promise.allSettled` and post-processes — fulfilled cells contribute their value; rejected cells either become the partial-error object (if allowed) or queue as the first fatal rejection (in DOM order) which the block re-throws after collecting siblings. Spec: §3.3 Error semantics. Conformance: `benchmark/scenarios/conformance/workflow-12.mjs` (two sub-cases: isolated allow-failure + mixed fatal+tolerated still halting).
- Workflow v0.5 — container-level pin (added 2026-05-19). Promoted from v0.4's non-goal list. The pin gesture (📌) now also attaches to container nodes — foreach `<li class="rwa-step rwa-foreach">` and parallel `<table class="rwa-parallel">`. Pinning a container writes `data-pinned-output` to its opening tag via the existing `setPinnedAttribute` flow; on next Run, `runForeach` / `runParallel` short-circuit before iterating / spawning cells and return the parsed pinned value as the container's output. Inner steps' `<output>` slots are NOT updated by the pin path. Containers don't get the ▶ Test button (deferred to v0.6) — pin only. Pinning a container with a malformed value throws `pinned_value_invalid_json` exactly like a leaf. Caveat: `<table>` isn't in `ANCHORABLE_TAGS`, so the substrate doesn't auto-inject `data-rwa-id` on parallel tables — authors and the agent MUST include it explicitly (the v0.4 spec §2.3 example already shows it). When a table lacks the id, the runner disables its pin button with a hint. Container staleness tracking remains deferred. `findStepInDoc` regex extended to match `<table>` opening tags. Badges sync via `<caption class="rwa-parallel-caption">` for tables (which can't host `<header>`). Conformance: `benchmark/scenarios/conformance/workflow-11.mjs`.
- `rwa import` ordering: apply seed-level substitutions (DOC_UUID/title/FILE) on the pristine seed first, *then* drop the imported content into INLINE_DOC. Doing it in the other order causes the `DOC_UUID` substitution to falsely match content the user imported (e.g. when importing another rwa file).
- HTML import keeps `<script>` tags intentionally (rwa documents can be interactive per the spec) and prints a stderr `note:` warning. Don't strip them silently.

## Conventions when editing the service (`service/`)

- The service is zero-dependency Node `http`. Don't add npm deps. Static assets are read once at startup from `service/public/`; updating them requires a rebuild.
- The landing page at `/` is a self-contained HTML file (`service/public/landing.html`) with one substitution marker: `{{SKILL_MD}}`. At startup the service reads the rewritable-building skill from `RWA_SKILL_PATH` (or the bundled fallback at `service/public/build-skill.md`) and inlines it into a `<script type="text/markdown" id="skill-md">` block, defensively escaping any `</script` substrings. The "Copy the rewritable skill" button reads from that inlined block — there's no second fetch. The "Download skill.zip" button on the same row hits `GET /skill.zip` for the multi-file bundle (see next bullet). The skill content (anchored to v0.10) must be self-contained — no references to files that don't ship with either the inline copy or the zip bundle.
- `GET /skill.zip` returns a STORED-only (no compression) zip built once at startup from the same `skillBody` buffer used by the landing page, plus every `.html` under `service/public/skill/examples/`. The zip's `SKILL.md` is byte-equivalent to what the copy button delivers. Examples are INLINE_DOC body fragments (no surrounding seed/bootstrap) since the skill teaches "fetch `/rewritable.html`, splice body in". The builder uses `zlib.crc32()` (Node 18.5+) and a pinned DOS mtime so the bytes are deterministic across restarts — `Cache-Control: public, max-age=300` is safe. If you update the skill or examples, replace the relevant files under `service/public/` (skill at `build-skill.md`, examples under `skill/examples/`) and rebuild; the layout has no other coupling to skill internals.
- Snapshot publishing (`POST /publish` → host-keyed share URLs) stores `<short>.html` + `<short>.json` pairs in `service/data/` (override via `RWA_DATA_DIR`). An hourly sweep deletes anything older than 24h. The handler substitutes a fresh `DOC_UUID` into uploaded bytes before storing. Rate-limit is in-memory per-IP, sliding 1h window; behind Traefik in prod the client IP is read from the leftmost `X-Forwarded-For` hop. **Each share lives at its own origin** — `<short>.rewritable.ikangai.com/` where `<short>` is exactly 8 lowercase-alphanumeric chars (the namespace is reserved by convention so future apex-style subdomains like `api.` don't collide). Server-side, host-keyed routing in `service/server.js` short-circuits share-host requests to `serveShare()`; apex routes (`/new`, `/import`, `/publish`, `/rewritable.html`, etc.) and `POST /publish` itself are unreachable on share hosts. Browser-side, this gives each share its own `sessionStorage`, IDB namespace, and OPFS root by same-origin policy — a malicious publisher's bootstrap can no longer enumerate or read any other share's storage. Wildcard cert via `letsencrypt-dns` (Traefik) + `auth.acme-dns.io` for the DNS-01 challenge (see `service/acme-dns/README.md`). Legacy `/s/<short>` paths 301-redirect to the host-keyed form during the 24h-expiry window of pre-migration shares (in local dev, where wildcard DNS doesn't resolve against `localhost`, `/s/<short>` falls back to path-keyed serve). 8-char share namespace reserved by `SHORT_HOST_RE` in `service/server.js` and the matching Traefik `HostRegexp` rule in `service/docker-compose.prod.yml`.
- Reserved URL prefix `/s/` belongs to snapshot publishing — don't reuse it for unrelated routes. Short codes are 8 chars from `[0-9a-z]`.
- `/import` is the browser-side counterpart to `rwa import`. Conversion (markdown → HTML) and the seed splice happen entirely in the user's browser; the server only serves the static page and the existing `/rewritable.html` (which already substitutes a fresh `DOC_UUID`). Don't move conversion to the server — the offline/no-upload property is intentional.
- `service/public/import.html` ports three pieces of `cli/src/seed.mjs` logic: `escapeTL`, the INLINE_DOC backtick-walk, and the TITLE/FILE substitutions (it does **not** mirror the DOC_UUID substitution — that's server-side via `/rewritable.html`). It also ports `convertCsv` / `looksLikeCsv`, `convertDocx`, `convertPdf`, and the `extractParagraphs` PDF heuristic from `cli/src/import.mjs`. **Four sites must stay aligned** when import logic changes: `cli/src/seed.mjs`, `cli/src/import.mjs`, `seeds/rewritable.html` (for the splice marker shape), and this file.
- `marked`, `papaparse`, and `mammoth` are loaded from cdnjs with pinned versions + SRI hashes. **pdf.js is self-hosted** at `service/public/pdf/{pdf.min.mjs,pdf.worker.min.mjs}` — it's ESM-only on cdnjs and the `integrity=` attribute on `<script type="module">` does not validate the URL the inline body imports, so cdnjs loading would have no real SRI protection. Bumping the CLI's `pdfjs-dist` version means re-copying both files from `cli/node_modules/pdfjs-dist/build/` into `service/public/pdf/` (and registering the new bytes in the docker image via `service/Dockerfile`'s existing `COPY service/public/`). For the cdnjs-loaded libs, recompute SRI on a version bump: `curl -sL https://cdnjs.cloudflare.com/ajax/libs/<lib>/<ver>/<file>.min.js | openssl dgst -sha512 -binary | openssl base64 -A`. Don't float versions — a CDN compromise on a floating reference would ship malicious code into freshly imported containers. Keep the pinned versions aligned with `cli/package.json`'s resolved versions so `/import` and `rwa import` stay byte-equivalent.
- Mammoth's HTML output has a fixed safe tag vocabulary, but does **not** filter `href`/`src` URL schemes — a docx with a `javascript:` hyperlink would land in `INLINE_DOC` and execute on click. Both `cli/src/import.mjs` and `service/public/import.html` post-process mammoth output through `sanitizeMammothUrls` (allowlist: `http`, `https`, `mailto`, `tel`, relatives, `data:image/*` for `<img src>` only). Keep the two implementations in sync.
