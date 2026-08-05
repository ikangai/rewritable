# Spec-fiction audit

**Status:** FINDINGS. Corrections in progress — see §5 for what is applied and what remains.
**Trigger:** [issue #7](https://github.com/ikangai/rewritable/issues/7), from the 2026-08-03 blindspot audit.
**Scope:** the 11 current normative specs (~5,300 lines). Excluded: actions v0.2–v0.7 and the
working-method addenda (explicit read-only history), and `rwa-operations-api.md` /
`rwa-product-types.md` (routing indexes that deliberately restate nothing).
**Method:** three independent sweeps, each required to verify every claim against
`seeds/rewritable.html`, `cli/src/`, `tools/`, or `service/` before reporting it. Claims that
checked out were not inventoried — this is a list of discrepancies, not a census.

## 1. Why this was worth doing

The project verifies code against code exceptionally well — cmp gates, parity tests, referee
oracles. Nothing verifies **prose against code**, so drift accumulates silently in exactly the
documents most likely to be trusted. Two instances surfaced by accident this week (the multi-tab
lock in #6, the `replace_document` exemption in #5), which prompted the sweep.

The pattern the sweep confirms is worth stating plainly: **the canonical specs were the outlier.**
`service/public/build-skill.md` — which ships to users — already said "Multi-tab is uncoordinated"
while `re-write-able-spec.md` §10.3 described a lock that never existed. `tools/self-description.mjs`
carries a source comment saying the spec's illustrative example was *proven wrong*, and the spec was
never updated. Drift concentrates where verification is weakest, and prose is the weakest.

## 2. Classification

- **NOT BUILT** — described as shipping, no implementation exists
- **STALE** — was true; the code moved and the spec did not
- **PARTIAL** — implemented, but materially narrower or different than described
- **UNDOCUMENTED** — the inverse: code does something normative the spec never mentions

## 3. Findings

### 3.1 Whole sections describing things that do not exist

| Where | Class | Claim | Evidence |
|---|---|---|---|
| `re-write-able-spec.md` §5.8 (Embedding and Composition, ~:239-259) | NOT BUILT | the embedder reads a sibling via FSA and renders it via `srcdoc`; three-mode sandbox table; dashboard embedding siblings | No `srcdoc` and no `runtime.read` anywhere in seed, `cli/src`, or `service/`. `window.runtime` (`:10670-10713`) has no `read` method. Zero implementation footprint. |
| `docs/specs/rwa-lens-spec.md` §2/§4 (~:57-71) | STALE | "the default state of the lens is a chat-input-style bar docked at the bottom of the viewport" | `#rwa-lens{display:none}` (`:174`, `:373`). Retired 2026-07-07, replaced by the `/` gesture → `#rwa-pal` + `#rwa-slash-hint`. **The spec's central surface no longer renders.** |
| `docs/specs/rwa-lens-spec.md` §12 Inv. 3 (~:65-67) | STALE | direct text "adds a new block at the end of the document" with no model call | `submitLens` is wired only to the hidden input; `runPal()` always calls `modify()`/`runSlashScope()`. Every content addition now goes through the agent. |
| `docs/specs/rwa-lens-spec.md` (~:205) | STALE | `/skin` and `/image` are "dispatched by the runtime itself" before the agent | Interception lives only inside the dead `submitLens`. `/skin like` moved to the ✦ panel as a plain field; `#rwa-pal` has no interception, so a literal `/skin` typed today goes to the agent verbatim. |

### 3.2 Error codes that can never be observed

| Where | Class | Claim | Evidence |
|---|---|---|---|
| `rwa-edit-dsl-spec.md` §6 (~:153-166) | PARTIAL | the DSL adds `op_unknown`, `op_malformed`, `region_not_found`, `region_not_unique`, `anchor_unparseable`, `attr_value_unrepresentable`, `all_with_zero_matches` | **None of the six exist in the seed.** `compileDslPlan` (`:7214-7357`) throws `malformed_envelope` for every one. The distinct codes are implemented in `cli/src/dsl-compiler.mjs` and the vendored service copy — so the table specifies the CLI, not the runtime end users actually run. Compounded: there is no `FAILURE_HINTS` entry for `malformed_envelope`, so the agent gets a bare code with no recovery hint. |
| `docs/specs/rwa-workflow-spec.md` §6 (~:368) | NOT BUILT | `step_script_no_run` — "Step body executed but did not define an async function named `run`" | No match repo-wide. `cli/src/seed.mjs:538-543` comments that a missing `run` resolves to `undefined` and calls that "user-acceptable" — the runner deliberately does the opposite of the spec. |
| `docs/specs/re-write-able-actions-spec-v0.8.md` (~:290) | PARTIAL | "IDB quota/IO failure throws `vault_quota_exceeded` / `vault_storage_error` … This is the closed set." | No match for `vault_quota_exceeded`. Every vault IDB failure path throws only `vault_storage_error`. |
| `rwa-edit-spec.md` §10 table | UNDOCUMENTED | reserved-marker-in-find/replace → `frozen_zone_violation` | True in the seed (`:7002`), but `cli/src/apply-edits.mjs` deliberately splits it and throws `reserved_substring`, a code absent from the spec's table entirely. A CLI caller reading only the spec misclassifies it. |
| `docs/specs/re-write-able-actions-spec-v0.9.md` (~:388,401) | PARTIAL | `bridge:idb` payload op ∈ `get\|put\|del\|subscribe\|all` | The Worker proxy (`:9163`) has no `subscribe`, and the bridge handler (`:9379-9391`) branches only on get/put/del/all — `subscribe` falls through to `invalid_argument`. (Document-side `runtime.db.subscribe` does exist; only the skill bridge lacks it.) |

### 3.3 Facts the code contradicts

| Where | Class | Claim | Evidence |
|---|---|---|---|
| `docs/specs/re-write-able-actions-spec-v0.8.md` (~:282,302) | STALE | vault session key "cached in `sessionStorage`"; persistence table lists it | Changed 2026-08-04 (#4): the key lives only in a closure with an idle auto-lock (`RWA.VAULT_IDLE_MS`, `:480`; `_vaultKey` `:7870`). **Drift introduced by this week's own work** and not propagated. |
| `docs/specs/rwa-self-description-spec.md` (~:80-82) | UNDOCUMENTED | "the kernel's five provider kinds" | `AFFORDANCE_KINDS` is six — `view`, `edit-surface`, `tool`, `compute`, `hook`, **`agent`** — identically in `tools/self-description.mjs:23`, `cli/src/identity.mjs:22`, and the live union. The spec undercounts its own kernel. |
| `docs/specs/rwa-self-description-spec.md` §2 schema | UNDOCUMENTED | field list omits `accountIdentity` | `runtimeDescribe()` emits it on every call (`:9462-9464`). A reader following "producers MUST emit every required field" does not know it exists. |
| `docs/specs/rwa-self-description-spec.md` §3 | PARTIAL | `hook` presented as an equal provider kind registrable like the others | `runtimeProvide()` (`:7464`) explicitly rejects `hook`. It can arrive only as an installed skill. `runtime.provide('hook', …)` throws. |
| `docs/specs/rwa-self-description-spec.md` §4/§9 (~:187) | STALE | datatable example: `view/grid, edit-surface/cell, tool/derive, compute/recalc` | The real demo declares 2 views + edit-surface + compute, no tool. `tools/self-description.mjs:38-39` says outright that the illustrative guess was proven **wrong** — and the spec was never updated. |
| `docs/specs/rwa-runtime-region-commit-spec.md` §7 + status footer (~:264,314) | NOT BUILT | skinning-v2 is the second live consumer, via `reachability:'edit-reachable'` | `applySkinL1` (`:5847-5871`) composes via `modify({compose})` and never calls `runtimeRegionCommit`. All four real call sites pass `'frozen'`. `edit-reachable` has **no** consumer. |
| `docs/specs/rwa-artifact-conventions.md` (~:204-220) | STALE | palette "warm cream", "terracotta accent"; fonts DM Sans / Instrument Serif "already wired in the bootstrap chrome" | Seed is neutral grayscale + system fonts (`:20-38`). No occurrence of those font or colour names anywhere. An author following this table builds against a design system that no longer exists. |
| `docs/specs/rwa-artifact-conventions.md` (~:66-73) | PARTIAL | any click on an anchorable element anchors the lens | Since the 2026-06-24 working-block redesign (`:3732-3738`), clicking `p`/`h*`/`blockquote`/`li` enters inline edit. Only `figure`/`pre`/`aside`/`table` still container-anchor. |
| `docs/specs/rwa-lens-spec.md` (~:83) | PARTIAL | "A rewritable opens in Document mode on every page load" | `:1064` — a `document`-kind container boots `edit`. False for the most common kind. |
| `docs/specs/rwa-lens-spec.md` §5.5 (~:161) | UNDOCUMENTED | anchorable set enumerated without `table`/`td` | `ANCHORABLE_TAGS` (`:471`) includes `TABLE` and `TD`. |
| `rwa-edit-spec.md` §12/§18 (~:450, ~:592) | STALE | "The cap of 15 is the load-bearing protection"; pseudocode hardcodes `slice(0, 15)` | `HIST_CAP:1000` (`:479`). The size-risk analysis ("hundreds of KB") is calibrated to a number 66× off. |
| `re-write-able-spec.md` (~:370) | STALE | default model is `google/gemini-3-flash-preview` | `MODEL:'google/gemini-3.5-flash'` (`:489`). The named default survives only as one datalist suggestion. |
| `re-write-able-spec.md` §5.11 (~:333) | STALE | the three share gestures are "the only network requests the runtime performs outside the agent backends" | `runtimeDiscoverSkills`/`runtimeFetchSkillFromIndex` (`:7792-7809`) fetch the marketplace index. Both are user-triggered, so the narrower "nothing fires at boot or ⌘S" clause still holds — the absolute claim does not. |

### 3.4 Not spec fiction — code that drifted from a correct spec

Two findings invert the usual direction. The spec is right; the **code** is stale. These are bugs,
not documentation debt, and are filed separately.

**The workflow system prompt is ~9 versions behind its own runner.** `seeds/rewritable.html:2856`
tells the authoring agent: *"Future surfaces (ctx.signal for cancellation, ctx.log, ctx.shared) are
reserved; do not use them in v0.2."* But `ctx.signal` shipped in v0.11 (`cli/src/seed.mjs:403-423`)
and `ctx.iter.parent` in v0.10 (`:614`); the runner also supports foreach, parallel, and test-steps.
The prompt mentions none of them and names only `ctx.credentials`. So an agent asked to build a
workflow authors v0.2-shaped output and never wires cancellation or iteration — a quality regression
in generated workflows, invisible from the spec side because the spec is correct. CLAUDE.md names
these three sites as required to stay aligned; two moved and one did not.

(`ctx.log` and `ctx.shared` genuinely remain unbuilt — that part of the sentence is still true.)

**Stale line-number citations.** Several specs cite seed line numbers that have drifted by 6,000+
lines as the file grew (`renderDoc` cited at `:224-268`, actually `:1229`; `runtime.describe()` at
`:4081`, actually `:10698`). The *behaviour* at each still checks out. Cosmetic, but it makes every
citation untrustworthy and therefore unused.

## 4. What this suggests about the gate

#7 proposed marking each normative section Built / Planned / Aspirational, and a CI check that
sections name a pinning test. The sweep supports a narrower, cheaper first step: **line-number
citations should not be hand-written**, because they rot silently and were the single most common
defect. Either drop them in favour of symbol names (`search for `function renderDoc``), which is what
CLAUDE.md already does well, or generate them.

The stronger measure remains: a normative claim about runtime behaviour should name the test that
pins it. Every finding in §3.2 would have been caught at write time by asking "which test asserts
this error code exists?"

## 5. Correction status

Applied in this pass — the ones that actively mislead someone building against them:

- [x] `re-write-able-spec.md` §5.8 — NOT BUILT banner
- [x] `rwa-edit-dsl-spec.md` §6 — the seed collapses all six codes to `malformed_envelope`
- [x] `docs/specs/rwa-lens-spec.md` — retirement header
- [x] `docs/specs/re-write-able-actions-spec-v0.8.md` §6 — vault key no longer in sessionStorage
- [x] `docs/specs/rwa-runtime-region-commit-spec.md` — `edit-reachable` has no consumer
- [x] `rwa-edit-spec.md` — `HIST_CAP` 15 → 1000
- [x] `re-write-able-spec.md` — default model name

Second pass — all remaining §3 findings now corrected:

- [x] `rwa-self-description-spec.md` — the `agent` kind (kernel undercounted itself), `accountIdentity` added to the field table, `hook` marked as not registrable via `provide()`, the datatable row replaced with what the real demo declares
- [x] `rwa-artifact-conventions.md` — palette and fonts rewritten to the actual grayscale/system-font system; the click-to-anchor item corrected, and its hazard upgraded (a stray click now drops a caret into live text, worse than the "stale highlight" the Known Limitations promised)
- [x] `rwa-edit-spec.md` §10 — `reserved_substring` added, with the CLI/runtime split stated
- [x] actions v0.8 `vault_quota_exceeded` (does not exist); v0.9 `bridge:idb` `subscribe` (never wired); workflow `step_script_no_run` (runner deliberately does the opposite)
- [x] `re-write-able-spec.md` §5.11 — network posture narrowed to what actually holds

Deliberately **not** done, with reasoning rather than silence:

- **`rwa-lens-spec.md` per-section rewrite.** The header added in pass one enumerates every false
  claim with evidence, so a reader is warned before reaching any of them. Rewriting §2 and §4 in
  place would mean re-authoring the document around a surface that no longer exists — that is a
  rewrite of the lens spec, not a correction to it, and it should be a deliberate editorial decision
  about whether the document becomes "the edit model" (the part that survived) or is superseded
  outright.
- **Stale line-number citations.** Corrected nowhere, on purpose: hand-written line numbers rot by
  construction, and patching this generation of them just resets a clock. §4 argues for dropping the
  practice instead.

Two findings are code bugs and are not this document's to fix: the workflow prompt drift
([#17](https://github.com/ikangai/rewritable/issues/17), fixed) and the missing
`malformed_envelope` failure hint (open, noted in the DSL spec's new §6 banner).

---

*Audit version 1. Findings: issue [#7](https://github.com/ikangai/rewritable/issues/7). The
code-side workflow-prompt drift (§3.4) is filed as
[#17](https://github.com/ikangai/rewritable/issues/17).*
