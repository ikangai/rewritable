# `rwa edit` — programmatic edit CLI design

Date: 2026-05-19
Status: design v0.3 — protocol facts verified against `seeds/rewritable.html`

## Problem

The rewritable runtime exposes `modify()` — the canonical mutation primitive — only inside the browser. The seed accepts envelopes (`apply_edits`, `apply_dsl_plan`, `replace_document`) from a model via ⌘K in the lens. Any program outside the browser wanting to change a rewritable file currently has two options:

1. Use `rwa new` / `rwa import` to create a fresh container — works only for initial seeding, not for updates.
2. Open the file and edit it by hand — works only for a human.

The triggering use case is the development diary skill (separate design doc): we want the diary to be a rewritable file the skill can append entries to. Splicing `INLINE_DOC` from inside the skill would mean mirroring the runtime's escape/backtick-walk logic, which already lives in three sites: `seeds/rewritable.html` (the `⌘S` build), `cli/src/seed.mjs` (the CLI's emit/import path), and `service/public/import.html` (the browser-side import). Skill-side splicing would be a fourth — the kind of duplication we're trying to avoid.

More broadly: any future skill, CI job, or automation that wants to update a rewritable needs the same primitive. Build it once.

**Mirror honesty.** The CLI itself is *not* mirror-free: routing `apply_dsl_plan` envelopes through Node requires a Node-loadable DSL compiler, which currently lives in three sites (spec / runtime / `benchmark/oracles/dsl-compiler.mjs`). Building `rwa edit` adds either a fourth site for the DSL compiler (option B2 below) or a one-time refactor that eliminates the mirroring (option B1). Both are addressed in [Runtime reuse](#runtime-reuse) — the trade is intentional and explicit, not glossed over.

## Decision

Add a single CLI verb: `rwa edit <file>`. It is the programmatic counterpart of ⌘K in the lens. Same edit grammar, same envelopes, same `modify()` semantics — different transport.

### Mental model

The rewritable is an intelligent artifact with a fixed edit grammar (frozen zones, three envelope shapes, audit log). Anything that wants to change it sends an envelope through `modify()`. The browser feeds envelopes via a model running inside the lens. The CLI feeds envelopes from the outside.

Envelopes can come from either source:

- **A model**: caller provides prose; the CLI runs the same agent loop the browser runs; the model emits an envelope.
- **Code**: caller provides an envelope directly.

Both paths converge in the same apply-and-commit logic. From the artifact's point of view they are indistinguishable downstream. One verb because it's one operation.

### Verb and dispatch

Invocation forms:

```
rwa edit <file> "instruction text"            # instruction path (agent-driven)
echo '<envelope-json>' | rwa edit <file>      # plan path (envelope on stdin)
rwa edit <file> --plan <plan.json>            # plan path (envelope from file)
rwa edit <file> --plan -                      # plan path (envelope on stdin, explicit)
```

The CLI accepts exactly one of three input sources:

1. **A positional string** — instruction mode.
2. **Piped stdin** (or the explicit `--plan -`) — plan mode reading from stdin.
3. **`--plan <file>`** — plan mode reading from a file.

Validation rules, in this order:

1. **Usage validation first.** Zero input sources → exit 1 (`usage_error`, subcode `missing_input`). Two or more input sources → exit 1 (`usage_error`, subcode `conflicting_input`).
2. **File validation second.** Target file missing → exit 2 (`file_error`, subcode `not_found`). File not parseable as a rewritable (no `INLINE_DOC` marker) → exit 2 (`file_error`, subcode `not_a_rewritable`).
3. Mode-specific validation follows (envelope shape for plan mode; backend/auth for instruction mode).

The CLI does not infer; agents and skills are told exactly what they invoked.

**`rwa edit` does not create files.** A missing target file exits with `file_error`, not auto-creation. Use `rwa new` to bootstrap; `rwa edit` only modifies existing rewritables. See [First-time file creation](#first-time-file-creation) for the intended pattern.

### Envelope detection and validation

The plan envelope JSON is validated in this order. Failure at any step → exit 3 (`envelope_error`) with the named subcode.

1. **`malformed_json`** — input does not parse as JSON.
2. **`not_an_object`** — parsed value is not a JSON object.
3. **Shape routing** — exactly one of `edits`, `ops`, `doc` must be present at the top level:
   - `edits` present → `apply_edits` shape
   - `ops` present → `apply_dsl_plan` shape
   - `doc` present → `replace_document` shape
   - Zero matches → `unknown_shape`
   - Two or more matches → `ambiguous_envelope`
4. **`missing_version`** — top-level `version` field is absent.
5. **`version_mismatch`** — `version` does not match the expected value for the routed shape: `"rwa-edit/1"` for `apply_edits` and `replace_document`; `"rwa-edit-dsl/1"` for `apply_dsl_plan`.
6. **Per-shape schema validation** matches the schemas in `seeds/rewritable.html:1484-1592`:
   - `apply_edits` requires `version`, `edits` (array of `{find, replace}` items, each `find` non-empty).
   - `apply_dsl_plan` requires `version`, `ops` (array of typed ops: `replace`/`insert`/`delete`/`set_attr`/`replace_document`).
   - `replace_document` requires `version`, `doc`, `reason` (non-empty string).
7. **Reserved-substring check** — `find` and `replace` strings in `apply_edits` (and the `replace`/`content`/`value` fields in DSL ops) must not contain reserved markers (`rwa:frozen:begin`, `rwa:frozen:end`, `<!-- rwa:`, `/* rwa:`, `// rwa:`, `data-rwa-frozen`). Violation → subcode `reserved_substring`.
8. **Apply-time checks** — once the envelope passes shape validation and (for DSL) compiles to `apply_edits`, the runtime's existing apply-time errors surface as subcodes: `find_not_found`, `find_not_unique`, `frozen_zone_violation`, `structural_shape_changed`.

Extra unrecognized top-level fields are ignored (forward compatibility); extra discriminator fields are an error (intent ambiguity, subcode `ambiguous_envelope`).

### Backend selection

Three backends, matching the browser's OpenAI-compatible set: `openrouter` (default), `ollama`, `lmstudio`. The fourth browser backend, `bridge`, is **excluded** — it's a browser-only localhost shim that exists precisely because the browser can't invoke a CLI. From the CLI, a user who wants `claude -p` invokes `claude` directly; no transport translation needed.

CLI flags mirror the browser settings panel — same defaults, same override semantics:

| Flag           | Env override                            | Default                              |
|----------------|-----------------------------------------|--------------------------------------|
| `--backend`    | `RWA_BACKEND`                           | `openrouter`                         |
| `--model`      | `RWA_MODEL`                             | `google/gemini-3-flash-preview`      |
| `--base-url`   | `RWA_OLLAMA_URL` / `RWA_LMSTUDIO_URL`   | backend-specific default             |
| `--api-key`    | `RWA_OPENROUTER_KEY`                    | (required for openrouter backend)    |

Flags override env; env overrides defaults. Same defaults as `seeds/rewritable.html` so a CLI invocation behaves identically to the lens.

### Error taxonomy and exit codes

Skills and agents are the primary callers. Five distinct exit codes; `--json` flag emits richer structure on stderr for finer dispatch.

| Code | Name             | Meaning                                                   |
|------|------------------|-----------------------------------------------------------|
| 0    | OK               | Edit applied, file written                                |
| 1    | usage_error      | Bad arguments, missing input, conflicting input sources   |
| 2    | file_error       | Input file missing, unreadable, or not a rewritable       |
| 3    | envelope_error   | Plan path: validation failure or apply failure (see [Envelope detection and validation](#envelope-detection-and-validation) for subcodes) |
| 4    | agent_error      | Instruction path: no envelope after retries, network failure, or no API key configured |

`--json` on stderr (opt-in) emits:

```json
{"code": "envelope_error", "subcode": "frozen_zone_violation", "details": {"zone": "rwa-bootstrap", "edit_index": 1}}
```

Five exit codes is enough for "what should I do about it?" (fix args / fix file / fix envelope / retry agent / done). Subcodes via `--json` let callers diagnose finer.

No interactive prompts. No "did you mean" inference. Strict and loud — agents do not benefit from forgiving CLIs.

### Stderr behavior

Without `--json`:
- Success: stderr silent.
- Instruction-path retries: one line per retry, e.g. `attempt 2/3: find_not_unique on edit 0, retrying`. Skills can grep these for observability.
- Failure: one short line naming the subcode plus relevant context.

With `--json`:
- Success: stderr silent (the new file is the output).
- Retries: one JSON object per retry, same schema as the failure object with `"phase": "retry"`.
- Failure: one terminal JSON object with `"code"`, `"subcode"`, `"details"`.

### File write semantics

The CLI writes atomically: serialize the new file bytes to `<file>.rwa-tmp-<pid>`, fsync, then `rename` over `<file>`. A killed process leaves either the original file untouched or the temp artifact, never a half-written `.html`. This mirrors the spec's invariant that the on-disk file is the only durable artifact — the CLI must not be able to corrupt it.

### Runtime reuse

The CLI needs Node-loadable versions of: `compileDslPlan`, apply-edits text substitution, frozen-zone enforcement, reserved-substring detection, and a way to extract the system prompt + tool schemas from the seed for the instruction path. Three implementation options:

- **A — Load the seed in jsdom on every invocation.** Zero mirror; exact reuse of the runtime code path. Cost: jsdom boot + bootstrap evaluation per call (≥200ms), and the CLI now has a heavyweight runtime dependency. Rejected for v1 — too slow for skills calling repeatedly.

- **B1 — Refactor: extract the runtime core into `lib/runtime-core.mjs`** that the seed `<script>` inlines at build time and the CLI imports directly. Eliminates the mirror by construction. Cost: introduces a build step for the seed (which today has none — see CLAUDE.md's "no build step" assertion), and changes how `seeds/rewritable.html` is authored. This is the right long-term structure but is an invasive refactor that should be a separate decision, not bundled into this CLI work.

- **B2 — Publish-time copy + committed snapshot.** The CLI carries `cli/src/dsl-compiler.mjs` (copied from `benchmark/oracles/dsl-compiler.mjs`) and `cli/src/apply-edits.mjs` (hand-mirrored from `seeds/rewritable.html`'s validator + apply path). Both files are **committed to the repo** so `npm test` and `node bin/rwa.mjs edit` work in fresh checkouts; the `prepublishOnly` hook **re-copies** `dsl-compiler.mjs` from the canonical source and runs a small conformance pass to verify the snapshot before publishing. **This is the v1 choice.**

**Cost of B2 — explicit:** the DSL compiler becomes a fourth mirror site (spec / runtime / benchmark / CLI). Apply-edits and frozen-zone enforcement become *first* CLI mirrors of seed logic. CLAUDE.md gains an explicit list of CLI files that must stay aligned with the seed, and the `prepublishOnly` hook gains a verification step.

**System prompt + tool schemas — new parsing work.** The CLI must extract `SYSTEM_PROMPTS`, `SYSTEM_PROMPT_RULES`, and `TOOL_SCHEMAS` constants out of `seeds/rewritable.html` (at `:1365`, `:1481`, `:1484` as of v0.10). Today, `rwa new` does only string substitution on the seed (DOC_UUID, FILE, INLINE_DOC body, kind-keyed marker blocks) and never parses out JS values. For v1 we add regex-based extraction with stable marker pairs — same approach `cli/src/seed.mjs` already uses to locate `INLINE_DOC` boundaries. The extracted values are loaded once per CLI invocation and cached for the duration of the process.

Apply-edits + frozen-zone module is realistic ~80 LOC. The agent loop (multi-turn tool-use, 3 retries, OpenAI-compatible transport, tool_result feedback wiring) is ~200-300 LOC.

### First-time file creation

`rwa edit` deliberately does not create files. A skill bootstraps a file in two steps:

```bash
# 1. Create a fresh container at the target path (positional, not --out)
rwa new --kind document .dev-diary/diary.html

# 2. Install the diary-specific initial structure via replace_document
cat <<'EOF' | rwa edit .dev-diary/diary.html
{
  "version": "rwa-edit/1",
  "doc": "<article>\n  <h1>Development diary</h1>\n  <div class=\"diary-controls\"><!-- search/filter/timeline UI --></div>\n  <div class=\"diary-entries\">\n    <!-- diary:entries:end -->\n  </div>\n</article>",
  "reason": "seed diary structure"
}
EOF

# 3. Subsequent /diary calls append entries via apply_dsl_plan
cat <<'EOF' | rwa edit .dev-diary/diary.html
{
  "version": "rwa-edit-dsl/1",
  "ops": [
    {
      "op": "insert",
      "before": "<!-- diary:entries:end -->",
      "content": "<section data-rwa-date=\"2026-05-19\">...</section>"
    }
  ]
}
EOF
```

Step 2's `replace_document` envelope installs the diary's initial structure including the `<!-- diary:entries:end -->` anchor that step 3 targets. This bootstraps with zero new CLI surface — no `diary` kind to maintain, no skill-side splice logic, no mirror sites added.

**Field-name reference** (from `seeds/rewritable.html:1484-1592`):
- `apply_edits` envelope: `version: "rwa-edit/1"`, `edits: [{find, replace}, ...]`, optional `reason`.
- `apply_dsl_plan` envelope: `version: "rwa-edit-dsl/1"`, `ops: [{op, ...}, ...]`. Insert op fields: `op: "insert"`, `before` *or* `after` (anchor), `content` (payload).
- `replace_document` envelope: `version: "rwa-edit/1"`, `doc: "<full body html>"`, `reason: "<non-empty string>"`.

Alternative considered: adding `--kind diary` to `rwa new` so step 2 is unnecessary. Rejected for now — keeps the kind-table to substrate-layer types (document, workflow) and lets diary stay a pure consumer of existing primitives. Revisit if the bootstrap pattern recurs across multiple skills.

### Diary skill consumption

What `/diary` does after the first run (full diary-skill design in a separate doc). Uses `marked` (already a CLI dep) to convert the entry body from markdown to HTML:

```js
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { marked } from 'marked';

const bodyHtml = marked.parse(bodyMarkdown);

const section = `<section data-rwa-id="entry-${date}-${shortHash}" data-rwa-date="${date}" data-rwa-tags="${tags.join(',')}">
  <h2>${escape(title)}</h2>
  <p class="meta">${formatDate(date)}</p>
  ${bodyHtml}
</section>`;

const plan = {
  version: 'rwa-edit-dsl/1',
  ops: [{
    op: 'insert',
    before: '<!-- diary:entries:end -->',
    content: section
  }]
};

const child = spawn('rwa', ['edit', '.dev-diary/diary.html'], { stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.write(JSON.stringify(plan));
child.stdin.end();
const [code] = await once(child, 'close');
if (code !== 0) throw new Error(`rwa edit failed with exit code ${code}`);
```

Plan path: deterministic, no API key, instant. The skill knows the entry structure so it never invokes the agent for routine appends.

A separate `/diary refine "make all March entries more concise"` command would use the instruction path. Not in v1 of the diary skill.

## Implementation overview

Files touched (full task breakdown belongs in an implementation plan):

| File                          | Status            | Purpose                                                   |
|-------------------------------|-------------------|-----------------------------------------------------------|
| `cli/bin/rwa.mjs`             | modified          | Add `edit` subcommand: arg parsing, mode dispatch, stdin detection. |
| `cli/src/edit.mjs`            | new               | Entry point: read file, detect mode, route to plan-applier or agent-loop, write file back atomically. |
| `cli/src/dsl-compiler.mjs`    | new, **committed**, refreshed at publish | Copied from `benchmark/oracles/dsl-compiler.mjs`. Committed so dev/test work in fresh checkouts; `prepublishOnly` re-copies and verifies before publish. |
| `cli/src/apply-edits.mjs`     | new               | Hand-mirrored apply-edits + frozen-zone + reserved-substring enforcement. ~80 LOC. |
| `cli/src/agent-loop.mjs`      | new               | Multi-turn tool-use loop (3 retries) against OpenAI-compatible backends. ~200-300 LOC. |
| `cli/src/seed-extract.mjs`    | new               | Regex-based extraction of `SYSTEM_PROMPTS`, `SYSTEM_PROMPT_RULES`, `TOOL_SCHEMAS` from the bundled seed. ~50 LOC. |
| `cli/tests/edit.test.mjs`     | new               | Test scenarios — uses `node:test` (Node ≥18 builtin, no dep). |
| `cli/tests/helpers/mock-backend.mjs` | new        | Local HTTP stub serving OpenAI-compatible responses for instruction-path tests. |
| `cli/package.json`            | modified          | Extend `prepublishOnly` to re-copy `dsl-compiler.mjs` and run a small conformance pass before publishing. |
| `cli/README.md`               | modified          | Document the new verb.                                    |
| `CLAUDE.md`                   | modified          | Add `cli/src/{dsl-compiler,apply-edits}.mjs` to the "must stay aligned" list. Note that `dsl-compiler.mjs` is auto-refreshed at publish time. |

**LOC estimate:** 600-900 across new files, plus ~50 LOC of diffs in existing files. Breakdown: `edit.mjs` ~150, `apply-edits.mjs` ~80, `agent-loop.mjs` ~250, `seed-extract.mjs` ~50, `dsl-compiler.mjs` ~150 (copied), tests + mock backend ~200.

## Verification

Per CLAUDE.md Rule 4 (goal-driven execution), success criteria. Sixteen scenarios go in `cli/tests/edit.test.mjs`, grouped by what infrastructure they need.

**CI-runnable (no external dependencies, no API keys):**

1. **Plan path — `apply_edits` envelope**: pipe a valid envelope with `version: "rwa-edit/1"` and an `edits` array → file rewritten, exit 0.
2. **Plan path — `apply_dsl_plan` envelope**: pipe a valid envelope with `version: "rwa-edit-dsl/1"` and an `ops` array → compiled to apply_edits → applied, exit 0.
3. **Plan path — `replace_document` envelope**: pipe a valid envelope with `version: "rwa-edit/1"`, `doc`, and `reason` → `INLINE_DOC` fully replaced, exit 0.
4. **Plan path — `frozen_zone_violation`**: pipe an envelope crossing a frozen zone → exit 3, no file change, `--json` stderr names `frozen_zone_violation`.
5. **Plan path — `find_not_unique`**: pipe an envelope whose `find` matches multiple substrings → exit 3.
6. **Plan path — `malformed_json`**: pipe non-JSON → exit 3, subcode `malformed_json`.
7. **Plan path — `ambiguous_envelope`**: pipe `{"version": "rwa-edit/1", "edits": [...], "doc": "..."}` → exit 3, subcode `ambiguous_envelope`.
8. **Plan path — `missing_version`**: pipe `{"edits": [...]}` (no `version`) → exit 3, subcode `missing_version`.
9. **Plan path — `version_mismatch`**: pipe `{"version": "rwa-edit/1", "ops": [...]}` → exit 3, subcode `version_mismatch` (DSL requires `rwa-edit-dsl/1`).
10. **Plan path — `reserved_substring`**: pipe an envelope whose `replace` contains `<!-- rwa:` → exit 3, subcode `reserved_substring`.
11. **Mode dispatch — `conflicting_input`**: `echo '{}' | rwa edit foo.html "instruction"` → exit 1, subcode `conflicting_input`.
12. **Mode dispatch — `missing_input`**: `rwa edit foo.html` with TTY stdin and no positional, no `--plan` → exit 1, subcode `missing_input`.
13. **File error — `not_found`**: `rwa edit nonexistent.html --plan p.json` (valid usage args) → exit 2, subcode `not_found`. Verifies usage-validation-first ordering AND no auto-creation.
14. **File error — `not_a_rewritable`**: `rwa edit somefile.txt --plan p.json` (file exists but has no `INLINE_DOC` marker) → exit 2, subcode `not_a_rewritable`.

**CI-runnable with local mock backend (`cli/tests/helpers/mock-backend.mjs` runs an HTTP server returning canned tool-call responses):**

15. **Instruction path — happy path**: `rwa edit foo.html "..."` with `--base-url` pointing at the mock → file updated, exit 0.
16. **Instruction path — retry exhaustion**: mock returns invalid tool calls only → exit 4 after 3 retries, `--json` stderr names `no_envelope_after_retries`.

**Local-only (require real backend, opt-in):**

17. **Instruction path — real openrouter**: requires `RWA_OPENROUTER_KEY`. Skipped in CI; gated by env var.
18. **Instruction path — `no_api_key`**: `RWA_OPENROUTER_KEY` unset, `--backend openrouter` → exit 4, subcode `no_api_key`.

The mock backend serves the same OpenAI-compatible shape as the production backends, so scenarios 15-16 exercise the full agent loop including JSON parsing, retry counting, and tool_result feedback wiring — without network or model dependencies.

## Out of scope (this design)

- **The diary skill itself**: entry schema, reader UI inside `diary.html`, migration from existing markdown entries, refine command — separate design doc.
- **`--dry-run`**: emit the envelope to stdout without applying. Useful as a pipe-through building block (`rwa edit a.html --dry-run "..." | rwa edit b.html`), but not needed for v1.
- **Multi-file batch editing**: rare; can be done by repeated invocation.
- **Concurrent-edit locking**: single-process for now. File locking deferred until a concurrent-write scenario surfaces. The atomic write-then-rename guards against half-written files but does not prevent lost-update races between concurrent CLI invocations.
- **Writing to `rwa_hist`**: the CLI has no IDB. The file-on-disk diff is the audit channel for CLI-driven edits. Browser sessions that later open the file see only the new `INLINE_DOC`; they do not see CLI edits in their per-session `rwa_hist`. CLAUDE.md already names the exported `.html` on disk as the only durable artifact, so this is consistent.
- **CLI-edit audit comments**: see Open question 1 — CLI edits are currently indistinguishable from human edits in `git diff`. May be worth a marker comment in v2; not v1.
- **`bridge` backend**: excluded (browser-only transport; CLI invokes `claude` directly if needed).
- **Direct `claude` backend**: not in v1. The instruction path's OpenAI-compatible transport covers the three useful backends. A `--backend claude-cli` shelling out to `claude -p` could be added later if demand surfaces.
- **`runtime.shared.*` interactions**: out of scope until spec §11.5 is resolved.
- **Runtime-core refactor (option B1)**: tracked as a future direction in [Runtime reuse](#runtime-reuse); not bundled into this CLI work.

## Open questions

1. **Should `rwa edit` write an audit comment into the doc on CLI-driven edits?** E.g. `<!-- rwa:cli-edit 2026-05-19T... actor:rwa-cli -->` before each section produced via the CLI, so `git diff` and browser readers can distinguish CLI-authored content from human-authored content. Matches the `actor` field added to `rwa_hist` in audit R2 of the runtime. The actor value for CLI edits would be `cli:<model-id>` (instruction path) or `cli:plan` (plan path). Tension with the reserved-substring rule (`<!-- rwa:` is reserved — would need a sub-namespace decision). Not v1.

2. **Should `rwa edit` re-validate the output by loading it in jsdom before writing?** Pro: catches malformed output before it's written to disk. Con: jsdom on every invocation defeats the point of choosing option B2 over A. Initial answer: no — the runtime validates on load in the browser, and the test scenarios above validate the apply logic at the unit level. Revisit if real-world bugs surface.

3. **Streaming output for the instruction path?** No for v1 (stderr retry lines aside — those already stream as documented in [Stderr behavior](#stderr-behavior)). The CLI returns when done. Long-running agent calls can be backgrounded by the caller. Could add `--stream` later if it proves useful for TUIs wrapping `rwa edit`.

---

Design version 0.3 — protocol facts verified against `seeds/rewritable.html:1484-1592`. Changes from v0.2: corrected envelope field names (`doc` not `document`; DSL `insert` op uses `before`/`after` and `content`, not `where`/`anchor`/`html`); added required `version` field to all envelope examples and made it part of validation order; added `version_mismatch` and `missing_version` subcodes; added `replace_document` `reason` field to bootstrap example; corrected `rwa new` invocation (positional path, not `--out`); simplified dispatch from eight-row table to three-source rule; specified validation order (usage first, file second); made SYSTEM_PROMPTS/TOOL_SCHEMAS parsing explicit as new CLI work (not pre-existing); added atomic-write semantics; added stderr behavior section; added `reserved_substring` test scenario plus `missing_version` and `version_mismatch`; fixed scenario count (text matches list); fixed `node:test` claim (Node ≥18 builtin, no dep); committed `cli/src/dsl-compiler.mjs` to the repo with publish-time refresh (resolves dev-time presence question); fixed comment-inside-template-literal example; replaced "sessionStorage conventions" wording; replaced "lens R2" with "audit R2"; gave audit-comment open question a concrete `actor` value.
