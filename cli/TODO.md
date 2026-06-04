# `rwa` CLI — Known Follow-ups

These items were surfaced during code review of the initial `rwa edit` implementation (Tasks 1-7). Each is non-blocking but worth tracking.

## Task 4 (`cli/src/edit.mjs`) — `replace_document` parity gaps with seed

The CLI's `replace_document` branch checks frozen-zone preservation (marker-form) but does NOT check:
- ~~Zone count match between current and new doc~~ — **DONE** (2026-05-30): `assertFrozenPreserved` now rejects a `replace_document` that ADDS a marker-form frozen zone (`frozen_zone_violation`), parity with the seed's `frozenZonesIntact` + the apply_edits count check.
- Unterminated marker detection (a stray `<!-- rwa:frozen:begin orphan -->` without a matching end passes the CLI)
- ~~Attribute-form `data-rwa-frozen` preservation~~ — **DONE** (2026-05-30): `replace_document` (and the DSL escape op) now enforce attribute-form frozen elements via `assertFrozenPreserved` → `dataRwaFrozenSnapshot`.
- HTML well-formedness (lone surrogate / parse validity)
- Class-lock coverage
- Reserved-id violation

These checks live at `seeds/rewritable.html:2911-2950`. The CLI's `replace_document` should mirror them for true parity. Tracked here pending a v2 hardening pass.

## Task 4 — Subcode naming

CLI uses `frozen_zone_violation` for both edit-time apply errors AND the new `replace_document` post-apply integrity check. The seed distinguishes: `frozen_zone_violation` for edit crossings, `frozen_zone_corrupted` for post-apply integrity. Pick one and align.

## Task 4 — Atomic write: missing `fsync`

The atomic write path does `writeFile + rename` but does not `fsync` before rename. On hard crash between rename and disk flush, both files can be lost. Add an `fsync` to match the design spec's "serialize the new file bytes, fsync, then rename" wording.

## Task 4 — `DslCompileError` not exported

`DslCompileError` is local to `dsl-compiler.mjs`. If future callers want `instanceof` discrimination, export it. Also: `applyPlan`'s error wrap drops `e.op` (the offending DSL op object) — pass it through in `details`.

## Task 5 — EACCES test skip mechanism — **DONE** (2026-05-30)

~~The EACCES test in `cli/tests/edit-plan.test.mjs` uses an early-return skip pattern that reports as PASS on Windows/root.~~ Now uses `node:test`'s `{ skip: <reason> }` option, so on root/Windows (where `chmod 000` can't trigger EACCES) it reports SKIPPED with a reason rather than a false PASS — honest reporting (Rule 12).

## Task 6 — `onRetry` argument shape

`{attempt, reason}` for no-tool-call but `{attempt, reason, toolName}` for invalid-JSON. Consider uniform shape with `toolName: undefined` in the no-call case.

## Task 7 — `OPENROUTER_API_KEY` env fallback

`rwa import --vision` reads `OPENROUTER_API_KEY`. `rwa edit` only reads `RWA_OPENROUTER_KEY`. Consider falling back to `OPENROUTER_API_KEY` for parity, or document the divergence in README.

## Task 7 — `--api-key` for non-openrouter backends

HELP text says ollama/lmstudio "ignore" `--api-key`, but the value is still passed in the Authorization header. Either drop the header for those backends or update the help text.

## Task 7 — `detectProductKind` regex

Currently a non-global regex that matches the first `const PRODUCT_KIND = '...'` in the file. If a future bootstrap places `INLINE_DOC` content before the const declaration, the regex could pick up document content. Add an anchor (e.g., match only against the bootstrap region).

## Task 7 — Stderr telemetry: em-dash → ASCII

`rwa edit: attempt 1/3 retrying — no_tool_call` uses an em-dash (`—`). Consider plain `--` for stricter ASCII compat.

## Cross-cutting — `replace_document` audit comment

Open question 1 from design v0.3: should CLI-driven edits emit an audit comment like `<!-- rwa:cli-edit 2026-05-19T... actor:cli:<model-id> -->` distinguishing from human edits? Currently CLI edits are indistinguishable from human edits in `git diff`. Pending design decision.

## Task 4 (`cli/src/apply-edits.mjs`) — additional seed parity gaps

Beyond the three documented scope-downs (structural-shape regex, marker-form-only frozen zones, reserved-substring split from frozen-zone), the CLI's apply pipeline omits the following seed invariants. All are tracked for v2:

- **`MAX_REPLACE` cap (8KB per edit)** — seed throws `replace_too_large`. DoS surface: a model emitting a 5MB `replace` succeeds in the CLI today; the runtime would reject on load.
- **`MAX_DOC` cap (1MB whole doc)** — seed throws `target_size_exceeded`. Same DoS surface for the whole-doc path.
- **`isWellFormed` lone-surrogate guard** — seed rejects invalid UTF-16 in `find`/`replace`/`doc`. CLI passes them through.
- **`canonLF` normalization** — seed normalizes `find`/`replace`/`doc` to LF before matching. CLI's literal `indexOf` means CRLF-anchored envelopes from some model tokenizers fail with `find_not_found` even when the browser would succeed.
- **Class-lock checks** — `class_lock_violation`, `class_lock_uncovered`. CLI doesn't enforce.
- **Reserved-id violation** — `reserved_id_used`. CLI doesn't enforce. A model can inject arbitrary `data-rwa-id` values (e.g. `<article data-rwa-id="hacked">`); the runtime backfills on next commit but these shadow runtime-assigned IDs until then.
- **`parse_error_post_apply`** — seed parses the post-apply doc as HTML and rejects on parse error. CLI relies on `structural_shape_changed` (script/style count) which is a weaker check.
- ~~**`data-rwa-frozen` attribute-form preservation**~~ — **DONE** (2026-05-30): `applyEdits` + `replace_document` (+ DSL escape) now enforce attribute-form frozen elements via the parser-free `dataRwaFrozenSnapshot` snapshot guard (`frozen_zone_violation`, `form:'attribute'`), mirroring the seed. Tests: `apply-edits.test.mjs`, `edit-plan.test.mjs`.

## Cross-cutting — apply-time tool_result feedback in agent loop

The CLI's agent loop in `cli/src/agent-loop.mjs` only retries on `no_tool_call` (model emitted plain text) and `invalid_json` (tool arguments aren't parseable). Apply-time failures (`find_not_found`, `frozen_zone_violation`, etc.) surface as `envelope_error` exit 3 with no retry.

The browser runtime (`seeds/rewritable.html:3220-3286`) feeds apply errors back to the model as `tool_result` (via `failureToToolResult`) and retries with the corrective context. Bringing this to the CLI would meaningfully improve robustness against models that emit "close-but-not-unique" envelopes — the model can refine its anchor and succeed on retry. Currently those models hard-fail.

Tracked for v2. Affects `cli/src/agent-loop.mjs` and possibly the `runAgentLoop` API (would need an `applyFn` callback parameter).

- `rwa clone` has no `--json` failure surface (other verbs do). Add a `jsonMode` branch to `emitClone` in `bin/rwa.mjs` if/when `rwa clone --json` is introduced.
