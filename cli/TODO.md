# `rwa` CLI — Known Follow-ups

These items were surfaced during code review of the initial `rwa edit` implementation (Tasks 1-7). Each is non-blocking but worth tracking.

## Task 4 (`cli/src/edit.mjs`) — `replace_document` parity gaps with seed

The CLI's `replace_document` branch checks frozen-zone preservation (marker-form) but does NOT check:
- ~~Zone count match between current and new doc~~ — **DONE** (2026-05-30): `assertFrozenPreserved` now rejects a `replace_document` that ADDS a marker-form frozen zone (`frozen_zone_violation`), parity with the seed's `frozenZonesIntact` + the apply_edits count check.
- ~~Unterminated marker detection (a stray `<!-- rwa:frozen:begin orphan -->` without a matching end passes the CLI)~~ — **DONE** (2026-06-09): `assertFrozenPreserved` rejects an unterminated begin marker, mirroring the seed's `extractFrozenZones` 'unterminated' → `frozenZonesIntact` reject. `frozen_zone_violation` with `reason: '…must not leave an unterminated frozen-zone marker'`.
- ~~3-fence-form byte-preservation + add-rejection + duplicate detection~~ — **DONE** (2026-06-10, review follow-up): the byte-preservation and add-rejection scans were initially comment-form-only (`findFrozenZones`) while the coverage/unterminated checks were 3-form — so a `/* */` or `//` zone could be silently dropped or minted, and a duplicate-name pair could smuggle a tampered shadow copy past a last-wins `Map`. `assertFrozenPreserved` now runs the full 3-form `extractFrozenZones3` (faithful mirror of the seed's `extractFrozenZones`, with `unterminated` AND `duplicate` flags) for ALL marker-form checks; `unterminatedFrozenMarker` is a thin projection of it so the standalone and full checks can't disagree. `findFrozenZones` stays comment-form-only on purpose — it is the REPORTING source for `rwa doc`/`ls` (SD-04), not the enforcement source.
- ~~Attribute-form `data-rwa-frozen` preservation~~ — **DONE** (2026-05-30): `replace_document` (and the DSL escape op) now enforce attribute-form frozen elements via `assertFrozenPreserved` → `dataRwaFrozenSnapshot`.
- ~~HTML well-formedness (lone surrogate)~~ — **DONE** (2026-06-09): `validateEnvelope` rejects an unpaired UTF-16 surrogate in `doc`/`reason` via `isWellFormedStr` (`malformed_envelope`/`lone_surrogate`). Parse-validity (`parse_error_post_apply`) stays a scope-down — the CLI is parser-free (no jsdom/DOMParser).
- ~~Class-lock coverage~~ — **DONE** (2026-06-09): `assertFrozenPreserved` rejects a `replace_document` whenever a bare `.rwa-locked` block in the CURRENT doc is not fully contained in a marker-form frozen zone (`class_lock_uncovered`), via parser-free ports of the seed's `lockedRangesIn` + `markerZoneRangesIn` (reusing the CLI's `matchingCloseEnd`/`tagHasFrozenAttr`). NOTE: this is the wholesale-rewrite coverage check only; the apply_edits **edit-crossing** check (`class_lock_violation`) is still open — tracked in the `apply-edits.mjs` section below.
- ~~Reserved-id violation~~ — **DONE** (2026-06-09): `assertFrozenPreserved` rejects an injected `id="rwa-doc-mount"` (`reserved_id_used`), parser-free mirror of the seed's `findReservedIdViolation`.

The seed reference lives in `seeds/rewritable.html` (grep `function replaceDocument`, `function extractFrozenZones`, `function lockedRangesIn`, `function markerZoneRangesIn` — line numbers drift, so the CLI mirror comments cite function names, not offsets). **Sole remaining scope-down vs the seed's `replaceDocument`**: `parse_error_post_apply` (a DELIBERATE divergence — the seed gets `DOMParser` free in the browser; the CLI is parser-free by design (offline-first, lean), and a parser-free well-formedness heuristic false-positives on valid HTML5 with optional close tags. Adding jsdom purely for a post-apply sanity check is disproportionate; `structural_shape_changed` + tag-balance is the practical guard). Everything else is mirrored: caps (`MAX_REPLACE`/`MAX_DOC`), `canonLF` normalization, lone-surrogate, marker-form frozen-zone integrity (3 fence forms, unterminated, duplicate, byte-preservation, add-rejection), attribute-form `data-rwa-frozen`, class-lock coverage AND apply-path crossing, reserved-id, and rwa-id-strict.

~~Two regex limits inherited from the seed~~ — **FIXED (2026-06-10) in BOTH seed and CLI**: `lockedRangesIn` now matches unquoted `class=rwa-locked` (quoted/unquoted alternation, seed + CLI together — pinned by `tests/lens.mjs` L8.1b and `cli/tests/apply-edits.test.mjs`); and `matchingCloseEnd` now counts self-closing same-tag opens as nesting like the seed's `findCloseTagEnd` (the prior exemption was the deviation — for non-void container tags HTML ignores the trailing slash).

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

- ~~**`MAX_REPLACE` cap (8KB per edit)**~~ — **DONE (2026-06-10)**: `applyEdits` throws `replace_too_large`. Measured on the raw (virtual/token under images-v1) replace bytes.
- ~~**`MAX_DOC` cap (1MB whole doc)**~~ — **DONE (2026-06-10)**: `applyEdits` throws `target_size_exceeded` on the final working copy (virtual/token form under images-v1).
- ~~**`isWellFormed` lone-surrogate guard**~~ — **DONE (2026-06-10)**: `applyEdits` rejects an unpaired UTF-16 surrogate in `find`/`replace` (`malformed_envelope`/`lone_surrogate`); `validateEnvelope` already covered `doc`/`reason`.
- ~~**`canonLF` normalization**~~ — **DONE (2026-06-10)**: `applyEdits` LF-canonicalizes the doc + every `find`/`replace` before matching, so a CRLF doc or CRLF-anchored envelope behaves identically to the browser.
- ~~**Class-lock checks**~~ — **DONE**: `class_lock_uncovered` on the `replace_document`/escape path (2026-06-09), and `class_lock_violation` (an `apply_edits` find-range crossing a `.rwa-locked` subtree) now wired into the per-edit loop (2026-06-10), mirroring the seed's apply path.
- **Reserved-id violation** — `reserved_id_used`. CLI doesn't enforce. A model can inject arbitrary `data-rwa-id` values (e.g. `<article data-rwa-id="hacked">`); the runtime backfills on next commit but these shadow runtime-assigned IDs until then.
- **`parse_error_post_apply`** — DELIBERATE scope-down (the only remaining one). The seed parses the post-apply doc with `DOMParser` (free in the browser); the CLI is parser-free by design (offline-first, lean) and a parser-free heuristic false-positives on valid HTML5 optional-close-tag patterns. `structural_shape_changed` (script/style count) + tag-balance is the practical guard. Revisit only if a real malformed-output incident justifies the jsdom dependency.
- ~~**`data-rwa-frozen` attribute-form preservation**~~ — **DONE** (2026-05-30): `applyEdits` + `replace_document` (+ DSL escape) now enforce attribute-form frozen elements via the parser-free `dataRwaFrozenSnapshot` snapshot guard (`frozen_zone_violation`, `form:'attribute'`), mirroring the seed. Tests: `apply-edits.test.mjs`, `edit-plan.test.mjs`.

## Cross-cutting — apply-time tool_result feedback in agent loop

The CLI's agent loop in `cli/src/agent-loop.mjs` only retries on `no_tool_call` (model emitted plain text) and `invalid_json` (tool arguments aren't parseable). Apply-time failures (`find_not_found`, `frozen_zone_violation`, etc.) surface as `envelope_error` exit 3 with no retry.

The browser runtime (`seeds/rewritable.html:3220-3286`) feeds apply errors back to the model as `tool_result` (via `failureToToolResult`) and retries with the corrective context. Bringing this to the CLI would meaningfully improve robustness against models that emit "close-but-not-unique" envelopes — the model can refine its anchor and succeed on retry. Currently those models hard-fail.

Tracked for v2. Affects `cli/src/agent-loop.mjs` and possibly the `runAgentLoop` API (would need an `applyFn` callback parameter).

- `rwa clone` has no `--json` failure surface (other verbs do). Add a `jsonMode` branch to `emitClone` in `bin/rwa.mjs` if/when `rwa clone --json` is introduced.
- `clone-extract.mjs` `findClassOpen` (the WordPress Profile 1 container locator) is not quote-aware: a `>` inside an earlier quoted attribute value (e.g. `<div data-x="a>b" class="entry-content">`) defeats the `[^>]*` scan, so the post falls through to the density fallback. `tagEnd`/`balancedInner` are already quote-aware; make the opening-tag locator quote-aware too (find the `<tag …>` with a forward `tagEnd` scan, then test the captured tag text for the `class` token). Low real-world impact (WordPress emits `class` early with simple attrs); flagged by the final-review M1.
- `publish-site.mjs` uses `scp` for a single-file copy. An `rsync` transport (checksum-based skip, `--chmod` for predictable remote perms, only-if-changed) is a possible v2 — quieter republishes and correct permissions without a second ssh round-trip.
- `resolveFlag` in `bin/rwa.mjs` is hard-wired to `emitEdit`, so `publish`/`publish-site`/`skin` each inline their own missing-flag-value check instead of sharing it. Making `resolveFlag` emitter-agnostic (take the emitter as a param) would let all branches share one implementation. Cross-branch refactor — out of scope for the publish-site change that surfaced it.
- `rwa host` (ingest into a hosted runtime, `src/host.mjs`) has **no retry/backoff** — a transient 5xx or a dropped connection fails immediately with `host_error/network_error`/`server_error` rather than retrying. Add bounded retry-with-backoff on idempotent-safe failures (the server's `POST /r` mints a fresh id per call, so a blind retry would create duplicate hosted copies — a retry would need the server to support an idempotency key first). Tracked for v2.
