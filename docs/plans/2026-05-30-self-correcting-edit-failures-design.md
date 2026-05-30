# Self-correcting edit failures — design

Date: 2026-05-30
Author: turing (parallel exploration iteration)
Status: design, in implementation

## North star alignment

Goal of this iteration: make rewritable *a pleasure for agents to work with*. The
single biggest friction for any agent (cloud model, local ollama/lmstudio, or
`claude -p` bridge) editing a rewritable is **getting the `find` anchor exactly
right**. `find_not_found` and `find_not_unique` are the dominant failure modes of
the rwa-edit/1 loop. Today the runtime hands the model back an opaque code and a
bare retry — with *no information about why the anchor missed*.

This iteration turns the structured failure into a **self-correcting** one:
deterministic, code-derived near-miss information so the model fixes its own
anchor inside the existing 3-attempt retry budget — and so the human sees a
legible reason instead of a raw code.

Not the model's job (Rule 5): the near-miss search and the hint text are pure
deterministic code. No extra LLM calls, no new deps, no protocol change beyond an
*additive* failure-context field. Stays self-contained.

## The gap (measured against the code)

- `seeds/rewritable.html:3027` — `find_not_found` throws with **zero context**.
  Contrast `:3028` `find_not_unique`, which already ships `{ count, hints:
  nearbySnippets(...) }`. The dominant failure gives the agent nothing.
- `cli/src/apply-edits.mjs:152-153` — already **drifted**: `find_not_found` carries
  `{ find }`, `find_not_unique` carries `{ find, count }` but **no `hints`** (the
  seed has snippets, the CLI doesn't).
- `failureToToolResult` (`:3551`) serializes `{ ok, code, ...context }` — no
  human-readable "how to fix" line for either the agent's `tool_result` or the
  human chip. Small/local models benefit most from a one-line steer.
- Spec `rwa-edit-spec.md` lines 109 / 394 / 417 enumerate helper context *per
  code* and conspicuously **omit `find_not_found`**. So enriching it is a
  spec-visible (additive) change — spec is source of truth and must be updated.

## Design

### 1. `findClosestAnchor(doc, find) → contextFragment`

Pure function. Given the working copy `doc` and a `find` that does **not** appear
verbatim, return the most actionable near-miss as a context fragment to spread
into the `RwaEditError`, or `{}` when nothing useful is found. Runs only on
failure (rare; latency-tolerant), so an O(n) pass over a ≤1 MB doc is fine.

Classification, in priority order (first hit wins):

1. **`whitespace`** — `find` matches a doc region after collapsing runs of
   whitespace to a single space. The #1 real cause (the model reproduced a block
   with subtly-off newlines/indentation). Return the **verbatim** doc substring so
   the agent can copy the exact bytes: `{ closest, match: 'whitespace' }`.
2. **`case`** / **`whitespace_case`** — matches case-insensitively (optionally
   also whitespace-normalized). Return verbatim doc substring.
3. **`partial`** — a distinctive token/chunk of `find` appears in the doc. Return
   the doc neighborhood around the best partial hit so the agent sees the real
   surrounding text: `{ closest, match: 'partial' }`.
4. none → `{}`.

Implementation notes:
- Build a whitespace-normalized projection of `doc` once with an offset map back
  to original indices; `indexOf` the normalized needle; map the match span back to
  verbatim doc bytes. Same projection reused for the case pass (lowercased).
- `partial`: probe the longest matching prefix of the normalized needle (galloping
  shrink, floor ~12 chars) and return its verbatim neighborhood.
- Cap returned `closest` to ~300 chars (head…tail elision) to keep the
  `tool_result`/JSON small.

### 2. `FAILURE_HINTS` — static code→one-line guidance

Small lookup table (Rule 2: only the high-frequency codes). One terse imperative
line each, e.g.:

- `find_not_found` → "`find` must match the document byte-for-byte (whitespace and
  case included). Use the `closest` text above, or pick a shorter unique anchor."
- `find_not_unique` → "`find` appears N times. Extend it with adjacent text to make
  it unique. Candidate locations are in `hints`."
- `frozen_zone_violation` → "Targets an author-protected frozen zone. Edit a
  different region."
- `structural_shape_changed` → "Changed the doc's script/style shape. Keep edits
  content-only, or use apply_dsl_plan for structural changes."
- (+ replace_too_large, reserved_id_used, empty_find, parse_error_post_apply)

Codes without an entry simply omit `hint`.

### 3. Wiring

- `failureToToolResult` appends `hint = FAILURE_HINTS[err.code]` when present
  (agent-facing `tool_result`).
- `find_not_found` throw becomes
  `throw new RwaEditError('find_not_found', i, findClosestAnchor(work, find))`.
- Human failure branch (`:3692-3698`, my lane per the chat seam with ada/hopper):
  the post-budget summary shows `code — hint` so a human sees a legible reason.
  (Visual styling of the chip stays ada/hopper's; I only enrich the *string*.)

## Sites to keep aligned (CLAUDE.md routing)

1. `seeds/rewritable.html` — `findClosestAnchor`, `FAILURE_HINTS`,
   `failureToToolResult`, the `find_not_found` throw. **Sequenced after hopper's
   Change-Awareness seed edits land** (same working tree).
2. `cli/src/apply-edits.mjs` — hand-mirror `findClosestAnchor` + `find_not_found`
   `closest`, add `hints` to `find_not_unique`. Flows into `rwa edit --json` via
   the existing `...e.context` spread (`edit.mjs:140,150`).
3. `rwa-edit-spec.md` — §10 / lines 109, 394, 417: document `closest`/`match` on
   `find_not_found` and the `hint` field; version bump + changelog.
4. `benchmark/scenarios/conformance/` — new scenarios asserting `find_not_found`
   now carries `closest`/`match` for a whitespace-only miss, and that `hint`
   surfaces. (Runs the real seed in jsdom.)
5. References (`hello.html`, `re-write-able-spec.html`) share the bootstrap →
   regenerate after the seed change.

## Success criteria (Rule 4)

- New conformance scenarios green: a whitespace-only `find_not_found` returns
  `match:'whitespace'` + a `closest` that, used as the next `find`, succeeds.
- Existing 78 conformance + jsdom suites stay green.
- CLI test suite green incl. new near-miss assertions; `rwa edit --json` emits
  `closest` on a near-miss.
- Spec + references regenerated; `cmp`/cli prepublish invariants intact.

## Explicitly out of scope (YAGNI)

- No fuzzy edit *auto-apply* — we only *inform*; the agent/human still chooses.
- No new LLM call, no diff UI (that's hopper's Change-Awareness lane).
- No change to the retry budget or the no-silent-escalation rule.
