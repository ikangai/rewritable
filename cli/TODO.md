# `rwa` CLI — Known Follow-ups

These items were surfaced during code review of the initial `rwa edit` implementation (Tasks 1-7). Each is non-blocking but worth tracking.

## Task 4 (`cli/src/edit.mjs`) — `replace_document` parity gaps with seed

The CLI's `replace_document` branch checks frozen-zone preservation (marker-form) but does NOT check:
- Zone count match between current and new doc (a `replace_document` that ADDS a new zone passes the CLI but would be rejected by the seed runtime)
- Unterminated marker detection (a stray `<!-- rwa:frozen:begin orphan -->` without a matching end passes the CLI)
- Attribute-form `data-rwa-frozen` preservation (consistent with Task 2's scope-down — same gap)
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

## Task 5 — EACCES test skip mechanism

The EACCES test in `cli/tests/edit-plan.test.mjs` uses an early-return skip pattern that reports as PASS on Windows/root. Should use `test.todo()` or `node:test`'s `{ skip: <bool> }` option for honest reporting.

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
