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
- `docs/specs/rwa-product-types.md` — layer-cake taxonomy (substrate → graph → skill).
- `docs/specs/rwa-workflow-spec.md` — workflow product shape (linear / foreach / parallel primitives).
- `docs/specs/rwa-self-description-spec.md` — `self-description/1` contract: what a container reports it is (kind + affordances + baseline), across static / live / declared projections (the "a rewritable knows what it is" surface).
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
- **Action/skill/permission/Worker-mode** → `docs/specs/re-write-able-actions-spec-v0.7.md`. Preserve cluster structure (§11.9, §11.10, §11.12). Bump to v0.8 if scope exceeds v0.7.
- **Product-type taxonomy** → `docs/specs/rwa-product-types.md`. Route to owning spec; don't restate.
- **Workflow product shape** → `docs/specs/rwa-workflow-spec.md` AND `cli/src/seed.mjs` (`KIND_WORKFLOW_BODY`) AND `SYSTEM_PROMPTS.workflow` in `seeds/rewritable.html`. Three sites must stay aligned. Regenerate references after.
- **Self-description / affordances** → `docs/specs/rwa-self-description-spec.md` (the `self-description/1` contract) AND `tools/self-description.mjs` (the reference **oracle/source**: `KIND_PROVIDERS`, `validateSelfDescription`, `checkAffordanceAgreement`, `parseDeclaration`, `declarationFacts`) AND `cli/src/identity.mjs` (publish-time mirror, pinned by `cli/tests/identity.test.mjs`) AND `seeds/rewritable.html` (`runtimeProvide`/`runtimeDescribe` — the live registry∪declaration union, mirrors the declaration helpers). **Four sites must stay aligned**; the oracle is the source, the others mirror/consume it. Provider kinds: `view`/`edit-surface`/`compute` (`tool`/`hook` deferred); custom kinds get `[]` static (honest), `declared > live > static` precedence. Regenerate references after a seed change.
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

Four backends, all routing through the same `modify()` lifecycle:

| Backend | Transport | Multi-turn tool-use? | Setup |
|---|---|---|---|
| `openrouter` (default) | `https://openrouter.ai/api/v1/chat/completions` with `Bearer <key>` | yes | API key in settings |
| `ollama` | `http://localhost:11434/v1/chat/completions` (override-able) | yes | `OLLAMA_ORIGINS=*` |
| `lmstudio` | `http://localhost:1234/v1/chat/completions` (override-able) | yes | CORS enabled in Developer tab |
| `bridge` | `POST http://127.0.0.1:8765/run` shelling out to `claude -p` | no (single-shot envelope) | run web_cli_bridge locally |

The first three share `resolveBackendConfig()` → `openAiCompatChat()`. Base URLs for `ollama`/`lmstudio` are overridable (sessionStorage `rwa_base_url_<backend>`). The settings "Test" button probes `GET <baseUrl>/models` and populates a `<datalist>`. `bridge` runs single-shot: `claude -p` has no mid-stream tool_calls, so the model emits an rwa-edit/1 envelope as text dispatched through the same apply* machinery.

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
- Seed-load order: `cli/seeds/rewritable.html` (in-package, created by prepublish) → `seeds/rewritable.html` (dev fallback). Don't add candidates without thinking through `npm publish` interaction.
- The CLI mirrors three pieces of bootstrap logic: `escapeTL`, the INLINE_DOC backtick-walk, and the DOC_UUID substitution regex. If any change in `seeds/rewritable.html`, mirror in `cli/src/seed.mjs`.
- Product-kind machinery: `rwa new --kind <name>` substitutes six regions via `kindOverrides(kind)` in `cli/src/seed.mjs` — INLINE_DOC body, `LENS_PLACEHOLDER`, `LEGACY_PAL_PLACEHOLDER`, `PRODUCT HEADER` comment, `PRODUCT_KIND`, `LENS_CLICK_TO_ANCHOR`. Adding a kind = one entry in `KIND_TABLE` + one in `SYSTEM_PROMPTS` + a line in `cli/README.md` and `cli/bin/rwa.mjs`. `applySeedSubs` enforces exactly-one match per region.
- `rwa import` ordering: apply seed-level substitutions (DOC_UUID/title/FILE) on the pristine seed first, *then* drop imported content into INLINE_DOC. Reversed order causes DOC_UUID substitution to false-match imported content.
- HTML import keeps `<script>` tags intentionally (rwa documents can be interactive) and prints a stderr `note:` warning. Don't strip silently.
- **`rwa edit` is the canonical programmatic edit entry point** for the CLI. Three invocation forms — positional instruction (agent loop), piped envelope on stdin, or `--plan <file>` — all funnel through the same `applyPlan` in `cli/src/edit.mjs`. Exit codes `0`/`1`/`2`/`3`/`4` (success / usage / file / envelope / agent) are stable. `--json` mode emits one JSON object per line on stderr for structured failure + retry reporting. The instruction path drives `cli/src/agent-loop.mjs` against an OpenAI-compatible backend (openrouter / ollama / lmstudio).
- **`rwa doc` is the read counterpart to `rwa edit`** (`cli/src/doc.mjs` → `inspectDoc`). Plain mode prints the LF-canonical editable body (the exact text the edit contract operates on, ± one trailing newline); `--json` emits a **`self-description/1` superset** of the editing contract on stdout — the prior `{rewritable, uuid, kind, frozenZones, length, doc}` plus the self-description fields `{rwa, source:"static", title, blocks, affordances, baseline}` ("what is this, what can be done with it" — `docs/specs/rwa-self-description-spec.md`). It reuses `extractInlineDoc` + `findFrozenZones` and the `edit.mjs` `CliError` so the `file_error` surface (`not_found`/`read_error`/`not_a_rewritable`, exit 2) is identical across read and write. stdout is reserved for the document/contract; all errors go to stderr. Never reads stdin, never writes the file. The `DOC_UUID`/`PRODUCT_KIND` extraction regexes mirror `seed.mjs` and `rwa.mjs detectProductKind` — keep them in step.
- **`cli/src/identity.mjs` is a publish-time mirror of `tools/self-description.mjs`** (the self-description/1 reference + referee oracle). The CLI can't reach repo-root `tools/` after `npm publish`, so `KIND_PROVIDERS`, `SUBSTRATE_BASELINE`, title/blocks extraction, the assembled static projection, **and the v1.1 declared-read** (`DECL_RE`, `parseDeclaration`, `declarationFacts`, `validateSelfDescription`, `resolveSelfDescription`) are duplicated in `identity.mjs` (same pattern as `apply-edits.mjs` mirroring the seed). No `cmp` gate — the mirror is pinned by test: `cli/tests/identity.test.mjs` deep-equals `KIND_PROVIDERS`/`SUBSTRATE_BASELINE` + `validateSelfDescription` (across valid + every failure mode) + `declarationFacts`/`parseDeclaration` against the reference, and `cli/tests/doc.test.mjs` deep-equals the whole `rwa doc --json` projection against `computeSelfDescription`. Drift fails the suite. When `tools/self-description.mjs` changes, re-mirror `identity.mjs`. **`rwa doc`/`rwa ls` apply the v1.1 precedence (`resolveSelfDescription`: `declared > static`)** — a trustworthy embedded `#rwa-affordances` declaration (edit-unreachable: outside `INLINE_DOC` or `data-rwa-frozen`, the latter now CLI-enforced) wins over the kind-template guess and emits `source:"declared"`; uuid/frozenZones/blocks are always filled from the bytes (container facts, authoritative over author claims); a non-conforming or edit-reachable declaration safely falls back to `source:"static"`. The runtime producer (`runtime.describe()` in the seed) emits the same shape live (registry∪declaration).
- `cli/src/dsl-compiler.mjs` is a **publish-time snapshot** of `benchmark/oracles/dsl-compiler.mjs` — do not hand-edit. The `prepublishOnly` script runs `cmp` BEFORE `cp`, so drift between the two fails the publish loudly rather than being silently overwritten. To roll a deliberate change, edit `benchmark/oracles/dsl-compiler.mjs` (the canonical site) and let the next publish refresh the snapshot.
- `cli/src/apply-edits.mjs` is **hand-mirrored** from `seeds/rewritable.html`'s validator + apply path (frozen-zone detection, reserved-marker check, structural-shape preservation, find/replace splice). Mirror manually when the seed changes — there is no cmp gate. Both frozen-zone forms are now enforced: **marker-form** (`<!-- rwa:frozen:begin/end -->`, via `findFrozenZones` per-edit crossing) AND **attribute-form** (`data-rwa-frozen`, via `dataRwaFrozenSnapshot` batch-level snapshot-equality, mirroring the seed's `dataRwaFrozenSnapshot` :2971 — parser-free `tag\0outerHTML` set, rejected as `frozen_zone_violation` `form:'attribute'`). The reserved-substring check additionally blocks edits whose `find`/`replace` literally mentions `data-rwa-frozen`. **Reporting** stays marker-form-only on purpose: `findFrozenZones` (→ `rwa doc`/`ls` `frozenZones`) mirrors the seed's `extractFrozenZones` (also marker-only), so the static and live `frozenZones` agree (SD-04). Remaining CLI scope-downs (size caps, class-lock, reserved-id, post-apply parse-validity) tracked in `cli/TODO.md`.

## Service conventions (`service/`)

- Zero-dep Node `http`. Don't add npm deps. Static assets read once at startup from `service/public/`; updates require rebuild.
- Landing page (`service/public/landing.html`) has one substitution: `{{SKILL_MD}}`. Service reads from `RWA_SKILL_PATH` (or `service/public/build-skill.md`) at startup and inlines into `<script type="text/markdown" id="skill-md">`, escaping `</script` substrings. Skill content must be self-contained — no references to files that don't ship inline or in the zip.
- `GET /skill.zip` returns STORED-only zip built once at startup from the same `skillBody` plus `service/public/skill/examples/*.html`. Deterministic bytes (`zlib.crc32()` + pinned DOS mtime); `Cache-Control: public, max-age=300` is safe.
- Snapshot publishing (`POST /publish` → `<short>.rewritable.ikangai.com/`): stores `<short>.html` + `<short>.json` in `service/data/` (override via `RWA_DATA_DIR`). Hourly sweep deletes >24h. Substitutes fresh `DOC_UUID` before storing. Rate-limit in-memory per-IP, sliding 1h, leftmost `X-Forwarded-For` behind Traefik. **Each share at its own origin** — 8-char `[0-9a-z]` short codes via `SHORT_HOST_RE`; matching Traefik `HostRegexp` in `service/docker-compose.prod.yml`. Wildcard cert via `letsencrypt-dns` + `auth.acme-dns.io` (DNS-01). Legacy `/s/<short>` paths 301-redirect (path-keyed fallback in local dev where wildcard DNS doesn't resolve).
- Reserved URL prefix `/s/` belongs to publishing — don't reuse.
- `/import` is the browser-side counterpart to `rwa import`. Conversion happens in the user's browser. Don't move conversion server-side — offline/no-upload is intentional.
- `service/public/import.html` ports `escapeTL`, the INLINE_DOC backtick-walk, TITLE/FILE substitutions (not DOC_UUID — server-side via `/rewritable.html`), `convertCsv`/`looksLikeCsv`, `convertDocx`, `convertPdf`, and `extractParagraphs` from the CLI. **Four sites stay aligned**: `cli/src/seed.mjs`, `cli/src/import.mjs`, `seeds/rewritable.html`, `service/public/import.html`.
- `marked`, `papaparse`, `mammoth` from cdnjs with pinned versions + SRI hashes. **pdf.js is self-hosted** at `service/public/pdf/` — `integrity=` on `<script type="module">` doesn't validate inline imports, so cdnjs has no real SRI protection. Bumping `pdfjs-dist` means re-copying `pdf.min.mjs` + `pdf.worker.min.mjs` from `cli/node_modules/pdfjs-dist/build/`. For cdnjs libs, recompute SRI on bump: `curl -sL <url> | openssl dgst -sha512 -binary | openssl base64 -A`. Don't float versions. Keep aligned with `cli/package.json` resolved versions.
- Mammoth's HTML output doesn't filter URL schemes. Both `cli/src/import.mjs` and `service/public/import.html` post-process through `sanitizeMammothUrls` (allowlist: `http`, `https`, `mailto`, `tel`, relatives, `data:image/*` for `<img src>` only). Keep in sync.
