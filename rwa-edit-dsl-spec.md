# rwa-edit-dsl/1 — structural transform DSL (draft v0.1)

A small, constrained vocabulary of structural transforms that **compile down to `rwa-edit/1` `apply_edits` envelopes** deterministically. The DSL is the "structural action surface" in the supervisor + worker architecture sketched in `benchmark/FINDINGS.md` and the conversation history that produced this draft.

The DSL is **not a replacement** for `rwa-edit/1`. It is sugar on top of it. Every DSL plan is compiled by the runtime into one or more `apply_edits` envelopes, which are then applied through the existing rwa-edit/1 path. The on-disk audit (`rwa_hist`) continues to record `edit_batch` records exactly as it does today.

This is a **draft** informed by the May 2026 baseline runs of `gemini-3.1-pro-preview` and `gemini-3.1-flash-lite-preview` against 89 fidelity scenarios (see `benchmark/results/RESULTS-gemini-3.1-*.md`). Numbers cited below come from those runs.

## §1. Why a DSL exists

The benchmark data showed two things that motivate this layer:

1. **Smaller models are more byte-disciplined than larger ones when emitting `apply_edits` directly.** On `mixed`-tag scenarios, gemini-3.1-pro-preview achieved meanT=0.00 (it rewrote substantial regions outside the requested edit), while gemini-3.1-flash-lite-preview held at meanT=0.44. On `paste` scenarios, pro at meanT=0.22 vs lite at 1.78 (pro modified pasted content; lite did not). Across all 89 scenarios, lite outperformed pro on stability by 50% (1.35 vs 0.88) at one-fifteenth the wall-clock cost.
2. **Stability is what `apply_edits` was designed for, but its raw shape (free-form `find`/`replace` strings) leaves room for the model to over-touch.** A model that knows only the DSL cannot emit an envelope that exceeds the DSL's expressive scope, regardless of how hard it tries.

The DSL therefore exists to **bound the model's action surface** without limiting what it can request. A `wrap_each` is what it is; the model cannot accidentally rewrite a paragraph by emitting a `wrap_each`. That guarantee comes from compile-down determinism, not from prompt engineering.

The DSL also gives the system a **replayable transform format**. A DSL plan is a JSON document. "Convert this to a kanban board" can be stored as a plan and applied to other documents — the same surface that protects the trust boundary also unlocks the parameterizable-transform product surface.

> **Adoption caveat.** The motivation above assumes the model emits the DSL. When the runtime offers all three tools (`apply_dsl_plan`, `apply_edits`, `replace_document`) and the model picks freely, adoption varies sharply by model class — flash-lite-class models often pick the DSL for structural transforms; pro-class models rarely do. See §12 for the empirical pattern from the 2026-05 production-runtime smoke runs. The DSL's design value (constrained action surface, replayability, audit) holds regardless of adoption, but the meanT ceiling specific to the May 2026 numbers cited above is reached only when the model actually emits DSL plans.

## §2. Scope and non-goals

The DSL covers **regular structural transforms** only — transforms whose intent can be expressed as a small fixed vocabulary applied to anchored regions. The four operational ops in `§4` plus the `replace_document` escape are intended to cover at least the eight structural_regular scenarios in the May 2026 benchmark (BULK-03, DATA-01, DATA-02, FID-03, FID-04, FID-05, GENRE-04, ROB-06) and the three new STRUCT-01..03 scenarios that exercise the DSL's iteration form.

The DSL deliberately **does not** cover:

- **Content rewrites.** Prose rewriting, translation, summarization, paragraph tightening, and similar are content-tag work. The supervisor delegates these to a worker LLM that emits its own `apply_edits` envelopes against a region; it does not emit DSL ops. The DSL has no `rewrite_text` op and will not get one.
- **Structural transforms that are irregular by nature.** "Move these three items here, that one there", sort-by-criterion, swap-by-mention. The supervisor self-executes these via direct `apply_edits` rather than via the DSL. The escape ladder (DSL → direct apply_edits → replace_document) handles this case in three steps.
- **Substantial paste.** When the user wants verbatim insertion of >N bytes (`§6.1` of `re-write-able-spec.md`), the supervisor detects this upstream and the runtime renders the paste directly without invoking either the DSL or a worker LLM. The DSL is not on the paste path.
- **Layout/CSS authoring or document genre changes.** Wholesale redesigns escape via `replace_document`, the same as in `rwa-edit/1`.

## §3. Versioning

This spec describes `rwa-edit-dsl/1`. The version number is independent of `rwa-edit/N` — the DSL can evolve on its own cadence as long as its compile-down target remains a valid `rwa-edit/1` (or later) `apply_edits` envelope. A DSL plan declares its version in its envelope:

```json
{ "version": "rwa-edit-dsl/1", "ops": [ /* ... */ ] }
```

Submissions with an unrecognized version yield `version_unsupported` (matching `rwa-edit/1` §10).

## §4. The four ops

Every op is a JSON object with an `op` field selecting the variant. Other fields are op-specific. All anchors and content are LF-canonical strings, identical to `apply_edits` semantics.

### §4.1 `replace`

```json
{
  "op": "replace",
  "find": "<string, must be uniquely locatable in the doc OR scoped by region>",
  "replace": "<string>",
  "region": "<optional: a unique anchor that scopes find to within its match>",
  "all": false
}
```

Replaces occurrences of `find` with `replace`. If `region` is set, the search is constrained to the match of `region` (which must itself be uniquely locatable — its match is the search window). If `all` is `true`, every occurrence within the search window is replaced; if `false` (default), the search window must contain exactly one match.

**Compiles to** one or more `apply_edits` envelopes. For `all: false`, exactly one. For `all: true`, the compiler emits one `apply_edits` edit per match, each disambiguated by surrounding context drawn from the search window. The compiler is responsible for ensuring every emitted edit's `find` is unique in the document at the time it is applied.

**Covers** scenarios: BULK-03, GENRE-04, ROB-06 (with `occurrence` semantics; see §4.3 if `delete` is preferred), and partial CONT-02 renumbering.

### §4.2 `insert`

```json
{
  "op": "insert",
  "content": "<string>",
  "after": "<anchor>"   // OR
  "before": "<anchor>"
}
```

Inserts `content` adjacent to the match of `after` (post) or `before` (pre). Exactly one of the two positional fields must be present. The anchor must be uniquely locatable in the document.

**Compiles to** a single `apply_edits` edit:
- `after`: `{ find: anchor, replace: anchor + content }`
- `before`: `{ find: anchor, replace: content + anchor }`

**Covers** scenarios: FID-04 (insert table row), DATA-01 (append JSON row), DATA-02 (append CSV row), CONT-02/03/06 (the structural-insertion components of mixed scenarios).

### §4.3 `delete`

```json
{
  "op": "delete",
  "target": "<string, uniquely locatable>"
}
```

Removes the matched substring from the document.

**Compiles to** a single `apply_edits` edit: `{ find: target, replace: '' }`.

**Note on `occurrence`.** Earlier drafts of this spec considered an `occurrence: <int>` field for "delete the Nth of N identical items". The May 2026 benchmark (ROB-06) showed that real models successfully disambiguate this case via surrounding context anchors, and the DSL inherits the rwa-edit/1 invariant that anchors must be unique. Therefore: **occurrence is not part of the v0.1 DSL.** Scenarios that require it MUST supply enough surrounding context in `target` to make it unique. If practice shows this consistently fails in a future benchmark, the field can be added in v0.2.

**Covers** scenarios: FID-05 (delete table row), partial ROB-06 (with disambiguating context).

### §4.4 `set_attr`

```json
{
  "op": "set_attr",
  "anchor": "<string: a tag-opening substring uniquely locatable in the doc>",
  "attr": "<attribute name, e.g. 'class'>",
  "value": "<attribute value, may be empty>"
}
```

Mutates an HTML attribute on the element whose opening tag matches `anchor`. The anchor must include enough of the opening tag to be unique. If `attr` is already present, its value is replaced; if absent, the attribute is appended before the closing `>`.

**Compiles to** a single `apply_edits` edit. The compiler:
1. Parses `anchor` as a partial HTML opening tag. It MUST end before the closing `>` so the compiler can append the attribute deterministically.
2. Detects whether `attr` is already present in `anchor` via a left-to-right scan respecting quote state. If present, rewrites its value; if absent, appends ` attr="value"` before the closing `>`.
3. Emits `{ find: original_anchor_completed_to_close_bracket, replace: new_anchor }`.

The compiler MUST escape the value: `"` → `&quot;`, `&` → `&amp;`. If the value contains characters that cannot survive HTML attribute serialization (e.g., NUL), the compiler returns `attr_value_unrepresentable` (see §5).

**Note on why this is a distinct op.** A model emitting raw `apply_edits` to mutate a class attribute typically rewrites the entire opening tag, often preserving all attributes but in a different order or with different quote style — both of which produce stability drift. Compiling `set_attr` deterministically guarantees byte-minimal change: only the attribute's value bytes (plus, in the append case, the new attribute substring) are touched. The May 2026 baseline showed FID-03 (the lone `set_attr`-style scenario) hitting meanT=2.00 on lite but still showing T variance — primarily because the model emitted slightly different whitespace inside the tag. A DSL-mediated path eliminates this category of drift.

**Covers** scenarios: FID-03, plus the second op in STRUCT-03's chain.

### §4.5 `replace_document` (escape)

```json
{
  "op": "replace_document",
  "doc": "<full new document>",
  "reason": "<short explanation>"
}
```

Identical semantics to `rwa-edit/1` §9.1's `replace_document` tool. The DSL accepts it as an op for orchestration uniformity (a DSL plan may end with `replace_document` if the structural changes are too irregular for the four positive ops). Compiles to a `replace_document` envelope; bypasses `apply_edits`.

**Covers** scenarios: BULK-04.

## §5. Compile-down semantics and the trust boundary

The DSL parser/compiler is the **trust surface**. Specifically:

- The runtime accepts a DSL envelope from the agent (or from a stored transform).
- The runtime parses the envelope, validates each op against this spec, and compiles each op to one or more `apply_edits` edits or one `replace_document` envelope.
- The compiled output is then applied through the existing `rwa-edit/1` path (`§5.4` of `rwa-edit-spec.md`), with all the existing invariants (mutex, validation, transactional IDB commit) intact.

This means:

- The DSL never bypasses `rwa-edit/1`'s validation. Anchors that fail to be unique still surface `find_not_unique`. Reserved markers in a DSL `content` field still surface `frozen_zone_violation`.
- The DSL is not arbitrary code. It cannot, for example, reach into `rwa_shared` or run JavaScript against the doc.
- Every DSL op produces `apply_edits` (or `replace_document`) envelopes that are auditable in `rwa_hist` exactly as they are today. The audit log records the **compiled** form, not the DSL form. This preserves the existing replay semantics. Optionally, the runtime MAY also record the originating DSL op as metadata in the `edit_batch` record's `meta` field, for replayability of the higher-level intent.

## §6. Error codes

In addition to all `rwa-edit/1` failure codes (which propagate from the apply phase), the DSL adds:

| code | when |
|---|---|
| `version_unsupported` | envelope's `version` is not `rwa-edit-dsl/1` |
| `op_unknown` | an `op` field does not match a defined op |
| `op_malformed` | a required field is missing or has the wrong type |
| `region_not_found` | `replace.region` is set but its anchor doesn't match in the doc |
| `region_not_unique` | `replace.region` matches more than once |
| `anchor_unparseable` | `set_attr.anchor` is not a parseable opening-tag prefix |
| `attr_value_unrepresentable` | `set_attr.value` contains characters that cannot survive HTML attribute serialization |
| `all_with_zero_matches` | `replace.all = true` but the search window contains zero matches |

These are reported back to the agent in the multi-turn loop using the same payload shape as `rwa-edit/1` §10 failures, so the agent can correct on retry.

## §7. Plan shape

A DSL **plan** is a sequence of ops applied in order. The runtime applies them sequentially and atomically per plan: either every op compiles and the resulting `apply_edits`/`replace_document` is applied, or none is. Partial application is forbidden.

```json
{
  "version": "rwa-edit-dsl/1",
  "ops": [
    { "op": "insert", "content": "<tr>...</tr>", "after": "<tr>...Bulkhead row...</tr>" },
    { "op": "set_attr", "anchor": "<tr><td", "attr": "class", "value": "highlight" }
  ]
}
```

Multi-op plans are how the supervisor expresses chained transforms. The compiler resolves anchors against the **post-compilation, pre-apply** doc state — anchors in op N+1 must match the doc as if op N had already been applied. The compiler is responsible for predicting the effect of preceding ops (which it can do exactly, since each op's effect is deterministic).

## §8. Replayability

A DSL plan is a JSON document and therefore storable. The runtime exposes (forward-looking; not yet implemented):

- `runtime.shared.transforms.save(name, plan)` — persists a plan keyed by name in `rwa_shared`.
- `runtime.shared.transforms.apply(name, params?)` — recompiles the plan against the current doc and applies it. `params` substitute into the plan's `content`/`find`/`replace` strings via mustache-style placeholders (`{{name}}`).

This is how "Convert to kanban" becomes a stored function. The trust surface (the DSL parser) is the same surface that bounds replayability — anything expressible in the DSL is replayable; anything not expressible in the DSL must be done as direct `apply_edits` and is not stored as a transform.

Cross-document apply requires careful anchor design (an anchor that's unique in document A may not exist in document B), but that's the user/author's problem, not the DSL's.

## §9. Relation to the supervisor + worker architecture

The DSL is one of three execution paths the supervisor can dispatch to:

1. **DSL plan** (this spec) — for regular structural transforms. Cheap, fast, deterministic.
2. **Worker LLM emitting `apply_edits` against a doc region** — for content rewrites within a bounded scope. Higher cost but bounded blast radius.
3. **Direct `apply_edits` from the supervisor itself** — for irregular structural cases the DSL doesn't compress.

`replace_document` exists at the bottom of the ladder as the universal escape.

The supervisor's **plan** is therefore typed: each step is either `dsl(plan)`, `worker(prompt, region)`, or `self_apply_edits(envelope)`. The May 2026 baseline data is the empirical justification for this typing — `mixed` scenarios show worse stability when one model handles the entire job than when the work is split across roles, *if and only if* the structural and content phases are isolated. The DSL is the mechanism that isolates them on the structural side.

## §10. What this spec does not yet decide

This is v0.1. Open questions deferred to a future revision:

- **CSS-selector anchors.** The DSL is currently string-anchored, matching `rwa-edit/1`'s semantics. Adding `selector: "div.card"` as an alternative to a literal string anchor would unlock `wrap_each(selector)` and similar, but introduces DOM dependency in the trust boundary. Not worth it until a benchmark scenario actually requires it.
- **`occurrence` parameter on `delete` / `replace`.** Currently both ops require uniquely-locatable targets, with disambiguating context as the user/model's responsibility. If real-world usage shows context-disambiguation consistently fails, revisit.
- **Plan-level conditionals.** "Apply this plan only if the doc has more than N sections" is a pattern that might emerge from cross-document replay. Not in v0.1.
- **Worker delegation tools as DSL ops.** An `op: "rewrite_text"` that the DSL compiler dispatches to a worker LLM would make the supervisor's plan a single artifact. Reasonable to consider in v0.2 once the worker-delegation runtime exists.

## §11. Test coverage map

The benchmark scenarios that exercise each DSL op (May 2026 taxonomy):

| op | exercising scenarios |
|---|---|
| `replace` | BULK-03, GENRE-04, ROB-06 (with manual disambiguation), CONT-02 partial |
| `insert` | FID-04, DATA-01, DATA-02, CONT-02/03/06 (structural component), STRUCT-03 (first op) |
| `delete` | FID-05, ROB-06 alternative |
| `set_attr` | FID-03, STRUCT-03 (second op), INTL-07 (`lang` attr update) |
| `replace_document` | BULK-04 |
| iteration (compiles to multiple sequential ops) | STRUCT-01 (wrap_each), STRUCT-02 (for_each_match) |
| out of scope | all other 73 scenarios — content, mixed-content-side, paste, failure_mode, drift, runtime |

A future runner mode (`fidelity:dsl`) would feed each scenario's expected DSL plan to the compiler and compare the resulting `apply_edits` envelope against the existing scenario stub. This validates that the compile-down preserves correctness scenario-by-scenario.

## §12. Empirical observations — production runtime + 2026-05-05 smoke

The motivation in §1 cites a May 2026 baseline where `gemini-3.1-pro-preview` meanT jumped from 0.88 (raw `apply_edits`) to 1.44 (DSL-mode runner that compiles `apply_dsl_plan` envelopes externally and applies via `ctx.applyEdits`). **That number was generated with a DSL-forced runner — the model was given only the `apply_dsl_plan` tool and had no choice.** Once the DSL shipped in the production runtime as a third tool alongside `apply_edits` and `replace_document` (2026-05-05), real-model runs revealed a different picture.

### The smoke runs

Both runs used the production runtime path (`window.modify`, three tools available, `SYSTEM_PROMPT` nudges toward `apply_dsl_plan` for structural transforms). 89 fidelity scenarios, N=3 (or N=1 for some).

| metric | gemini-3.1-pro-preview | gemini-3.1-flash-lite-preview |
|---|---|---|
| Overall meanS | 1.73 | 1.57 |
| Overall meanT | 1.02 | 1.24 |
| `apply_dsl_plan` adoption (across all model calls) | **0.8 %** (2 / 244) | **~70 %** on structural; 0 % on content |
| structural_regular meanT | 1.76 | 1.33 |
| paste meanT | 1.78 | 1.78 |
| mixed meanT | 0.00 | 0.67 |

For comparison, the May 2026 apply_edits-only baselines: pro overall meanT=0.88, lite overall meanT=1.35.

### Findings the data forces

**1. Pro almost never picks `apply_dsl_plan` when given the choice.** Despite the system prompt's "preferred for STRUCTURAL transforms" guidance, pro emitted `apply_edits` 230 times and `apply_dsl_plan` 2 times across 89 scenarios. The prompt's tool-preference language is a nudge that the model freely overrides — most likely because `apply_edits`-shaped (str_replace-style) tool surfaces dominate training data and feel default to a strong model.

**2. Most of pro's stability gain comes from the prompt structure, not the new tool.** Pro on the apply_edits-only baseline got paste meanT=0.22 (it modified pasted content). Pro on the new 3-tool prompt — *still using `apply_edits` exclusively for paste* — gets paste meanT=1.78 (+1.56). The "If the user's input is itself substantial content, render it, don't summarize it" rule and the explicit structural-vs-content split do real work even when the new tool isn't selected. The same pattern holds on `structural_regular` (1.27 → 1.76) and `failure_mode` (1.27 → 1.47).

**3. Lite adopts the DSL freely but sees no net stability win.** Lite picks `apply_dsl_plan` ~70 % of the time on structural-tag scenarios (84 % on `structural_regular` specifically). But its overall meanT moved from 1.35 (apply_edits-only) to 1.24 (3 tools available) — a slight regression. Lite was already byte-conservative on raw `apply_edits`; the DSL doesn't add discipline, only adds prompt-overhead and minor compile-down anchor widening (e.g., `set_attr` compiles to a wider find than the model's own minimal anchor).

**4. The May 2026 forced-DSL ceiling (pro meanT=1.44) doesn't reproduce in production** because pro doesn't adopt the tool. The runtime smoke lands pro at meanT=1.02 — better than apply_edits-only's 0.88 (+0.14) but well short of 1.44.

### Implications for the protocol

- The DSL spec assumed adoption would track the prompt's preference order. In practice, adoption is **inversely correlated with model capability**: weaker models follow the prompt; stronger models override it.
- The DSL still earns its keep as: (a) a constrained-action surface for replayable transforms (§8), (b) discipline-by-construction for callers who want to lock in byte-minimality regardless of model adoption (a future "structural-edits-only" mode that disables `apply_edits` would unlock the 1.44 ceiling), and (c) compile-down semantics that lite-class models pick up freely.
- The system prompt's structural-vs-content split is itself a load-bearing artifact — it produces measurable fidelity gains independent of tool selection. **Future prompt changes should preserve the explicit section-by-section rules, not just the tool list.**
- Don't assume `apply_dsl_plan` will be the dominant tool surface in production. It isn't, for strong models.

### Open questions for v0.2

- **Why pro avoids the DSL.** Schema complexity (the `oneOf` op switch)? Familiarity bias (`apply_edits` is a known shape)? Description framing ("preferred" too soft)? A flatter schema, a stronger imperative, or a different tool name might shift adoption — testable in a future round.
- **A runtime-level DSL-only mode.** A flag that disables `apply_edits` for structural intent and forces the agent into the DSL would unlock the May 2026 forced ceiling, at the cost of agent flexibility on edge cases. Value depends on whether the +0.42 meanT gap is worth the constraint.
- **Whether the DSL belongs as the primary tool name.** If `apply_edits` is what models reach for, perhaps the DSL should be a *flag* on `apply_edits` (e.g. `mode: 'dsl'` with structured ops in the same envelope) rather than a sibling tool.

These are deferred to a future spec revision once more model coverage exists.

---

Spec version 0.1 — initial draft, May 2026, informed by 89-scenario baseline of `gemini-3.1-pro-preview` and `gemini-3.1-flash-lite-preview`; §12 added 2026-05-05 after the production-runtime smoke runs revealed the adoption pattern. Companion documents: `re-write-able-spec.md` (container spec, v0.8), `rwa-edit-spec.md` (edit protocol, v1.4).
