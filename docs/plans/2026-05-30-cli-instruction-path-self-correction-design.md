# CLI instruction-path self-correction — design (iteration-2, ready)

Date: 2026-05-30
Author: turing
Status: design, NOT yet executed (queued lane — seed-free, cli/ only)

## The gap

`rwa edit "<instruction>"` drives an **internal** model via `runAgentLoop`
(`cli/src/agent-loop.mjs`). That loop retries the model only on *envelope*
failures (`no_tool_call`, `invalid_json`) — up to 3×. It then returns the first
valid envelope, which `rwa.mjs:412` applies via `applyPlan` **terminally**: a bad
anchor → `CliError` exit 3, and the internal model **never sees the failure**.

Contrast the seed's `modify()` loop, which feeds *apply* failures
(`find_not_found`, …) back as `tool_result` and retries 3×. So the in-browser
lens self-corrects its anchors; the CLI instruction path does not. With
iteration-1 landed, the failure now carries everything needed to self-correct
(`closest` / `match` / `hint`) — it just isn't routed back to the internal model.

This is the last self-correction asymmetry between the lens and the CLI. The
`--plan` path stays terminal-by-design (the *external* caller is the model and
already gets `closest`/`hint` via `rwa edit --json`); only the instruction path,
which owns an internal model, should retry.

## Design (additive, mirrors the seed)

1. **Decompose `applyPlan`** (`cli/src/edit.mjs`) into three reusable pieces —
   no behaviour change to `applyPlan` itself, which becomes their composition:
   - `readDoc(filePath) → { fileText, currentDoc }`
   - `applyEnvelopeToDoc(currentDoc, envelope) → newDoc` (validate + dispatch;
     throws the existing `CliError` — which already carries
     `details.{closest,match,truncated,hint}` from iteration-1)
   - `writeDocToFile(filePath, fileText, newDoc)` (the atomic tmp+rename+fsync)

2. **`runAgentLoop` gains an optional `applyEnvelope` callback.** When provided,
   after a valid envelope parses, the loop calls `applyEnvelope(envelope,
   toolName)`:
   - success → return `{ envelope, toolName, messages, newDoc }`
   - structured failure (CliError with a `subcode`) → push a `tool_result`
     `{ ok:false, code: subcode, ...details }` (so the model sees
     `closest`/`hint`) and `continue` the retry loop, exactly like the existing
     `invalid_json` branch (echo-trim parallel tool_calls included)
   - non-structured throw (e.g. disk write) → rethrow (terminal)

   When `applyEnvelope` is absent, behaviour is **unchanged** (returns the first
   valid envelope) — backward-compatible; the `--plan` path and existing tests
   are untouched.

3. **`rwa.mjs` instruction path** passes
   `applyEnvelope: (env) => applyEnvelopeToDoc(currentDoc, env)` (dry-run, no
   write), then on loop success calls `writeDocToFile(...)` once. The retry
   budget (3) and `onRetry` telemetry already exist; add `reason:'apply_failed',
   code` to the telemetry.

## Why this shape

- One retry budget, one message manager (the loop), one error surface — matches
  the seed's `modify()` exactly (agent-loop's own header says it mirrors it).
- `CliError` already carries the near-miss + hint (iteration-1, commit 07fc311),
  so the fed-back `tool_result` is self-correcting with zero new lookup.
- Additive callback ⇒ `--plan` path and all current tests stay green untouched.

## Tests (TDD)

- `agent-loop.test.mjs` (mock backend): first turn emits a whitespace-off anchor
  → loop feeds back `{closest,...}` → second turn emits `closest` verbatim →
  loop returns `newDoc`. Assert: 1 retry fired, final doc applied.
- `agent-loop.test.mjs`: apply keeps failing all 3 turns → `AgentError`
  `no_envelope_after_retries` (or a new `apply_unrecovered`), no write.
- `edit-dispatch.test.mjs` (e2e, mock backend): `rwa edit "<instr>"` where the
  model misses then fixes → exit 0, file written; assert retry telemetry on
  stderr.

## Success criteria

- New tests green; full CLI suite + conformance + jsdom stay green.
- `--plan` path byte-identical behaviour (no regression).
- Manual: `rwa edit "<instr>" --backend ollama` self-corrects a near-miss in one
  retry.

## Out of scope (YAGNI)

- No change to `--plan` (terminal-by-design). No new wire fields. No change to
  the retry budget (stays 3, shared across parse + apply failures).
