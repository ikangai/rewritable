# Benchmark state — `seeds/rewritable.html` vs. spec v1.3

This file replaces the earlier "4 runtime gaps" report. As of the second
autoresearch loop completion:

- **Conformance: 42 / 42 passing.** All four gaps surfaced by the first
  loop (CONFORM-10, CONFORM-11, CONFORM-14, EDGE-05) are now fixed in
  the runtime. See "Runtime fixes landed" below.
- **Fidelity: 9 scenarios scaffolded across 4 categories** (FID, PRES,
  ID, CONT). All pass with stub models at S=2.00/T=2.00/drift=0.0000.
  Real-model scoring is gated on an OpenRouter API key — see "Plugging in
  a real model" below.
- **Existing tests/e2e.mjs: 266 / 266 passing.** Runtime fixes did not
  regress the existing test suite (one test, 41b, was updated to assert
  the new structured `concurrent_modify` contract).

## Runtime fixes landed

Each fix is small, local, and accompanied by a regression-blocking commit
on the `main` branch. References below cite the post-fix line numbers.

### 1. `computeShape` tracks distinct top-level tag types

`seeds/rewritable.html:421-441` — replaced `{ scripts, styles }` with
`{ scripts, styles, topLevelTypes }` where `topLevelTypes` is the
sorted set of distinct top-level tag names directly under `<body>`.
Catches CONFORM-11 (introducing a new top-level element type).

The choice of *set* over *multiset* threads a needle: splitting one
`<p>` into two `<p>`s is a legitimate edit (existing tests/e2e.mjs Test
48), but introducing `<section>` alongside an existing `<div>` is a
shape change. Set-based comparison allows the former and rejects the
latter.

### 2. Token-level `<script>` / `<style>` balance check

`seeds/rewritable.html:347-363` — `tagBalance(doc)` counts raw `<script>`
opening tokens and `</script>` closing tokens (and same for style); the
post-edit count must match. The HTML5 parser auto-closes a truncated
`<script>` at EOF, leaving the post-parse shape unchanged while the doc
is actually corrupted (a lone `<script>` swallows all following markup
as text). The token-level check catches this where the parsed-shape
check cannot. Catches CONFORM-10.

The check is asymmetric — only fires if balance is *introduced* in the
imbalance, not pre-existing. A container that for some reason starts
imbalanced is allowed to be edited; the runtime won't make it worse but
won't refuse to load it either.

### 3. `concurrent_modify` is a structured `RwaEditError` throw

`seeds/rewritable.html:589-592` — `modify()` now throws
`new RwaEditError('concurrent_modify')` when the modify mutex is held,
instead of returning `undefined` after a UI status flash. The two
keyboard-shortcut callers (`⌘K` palette enter and the go button) wrap
their invocations in `.catch(err => …)` to suppress unhandled rejection
noise without hiding programming errors.

`tests/e2e.mjs` Test 41b updated to await-with-catch and assert
`err.code === 'concurrent_modify'`. Catches CONFORM-14.

### 4. UTF-16 well-formedness validation

`seeds/rewritable.html:478-489` and `534-538` — both `applyEdits` and
`replaceDocument` call a small `isWellFormed` helper on every string
input (find/replace/doc/reason). The helper uses
`String.prototype.isWellFormed()` (ES2024, available in Node 22+ and
Chromium 124+); on older runtimes the check is treated as unavailable
rather than always-false. Lone surrogates throw `malformed_envelope`
with `context.reason: 'lone_surrogate'`. Catches EDGE-05.

## Fidelity layer

The fidelity layer scaffolds the spec v1.3 §4 + §5 categories with a
stubbable model and reusable oracles.

### What's there

```
benchmark/
├── oracles/
│   ├── diff.mjs            # drift_ratio (single-hunk + envelope-based)
│   ├── selector.mjs        # CSS selector assertion runner
│   └── *.test.mjs          # 16 self-tests for the oracles
├── runners/
│   ├── model.mjs           # stubModel + openRouterModel + modelToFetch
│   └── run-fidelity.mjs    # discovers + runs scenarios/fidelity/*.mjs
├── fixtures/
│   ├── manifest.json
│   └── templates/article-medium/{clean,clean-rich}.html
└── scenarios/fidelity/
    ├── fid-01.mjs … fid-06.mjs  (FID core anti-drift)
    ├── pres-04.mjs              (inline element preservation)
    ├── id-03.mjs                (anchor reference preservation)
    └── cont-01.mjs              (cross-reference count update)
```

### What stub-model results show

All 9 scenarios at S=2.00 / T=2.00 / drift_ratio=0.0000 across N=3 runs
each. Synthetic token usage in the 800-1100 range (input-dominated;
fixture is the largest part of the user prompt). Wall time 5-15ms per
run because the stub returns instantly — real models will be 10×-100×
slower.

This validates the *plumbing*: fixture loading, model invocation,
runtime modify path, oracle scoring, result aggregation, TSV output. It
does not say anything about *model* fidelity — the stub knows the
answer.

### Plugging in a real model

Set `RWA_OPENROUTER_KEY` in the environment and pass a model name to the
runner:

```sh
export RWA_OPENROUTER_KEY=sk-or-...
cd benchmark
node runners/run-fidelity.mjs google/gemini-3-flash-preview
```

The runner detects the model name (anything other than literal `stub`)
and delegates to `runners/model.mjs`'s `openRouterModel(...)`. Per-run
operational metrics (`tokens_in`, `tokens_out`, `wall_ms`,
`retry_rounds`) are then real, and per-scenario S/T scores reflect the
model's actual editing behavior.

The result file `benchmark/results/fidelity.tsv` records: id, category,
N, meanS, meanT, medianDrift, tokens_med, tokens_p95, wall_ms_med.

## What's still missing for a v1.3-complete benchmark

The spec calls for substantially more than what's wired up. Concrete
deltas vs. spec v1.3:

| Spec ref | Status | Notes |
|---|---|---|
| §4 fidelity (80 scenarios across 13 categories) | 9 / 80 wired | Categories not yet covered: DATA, APP, BULK, ROB, INTL, INTERACT, GENRE, FAIL, DEG. Each new scenario is a small `.mjs` file matching the existing pattern. |
| §5b conformance (42 scenarios) | 42 / 42 ✓ | Complete. |
| §5 DEG-01..03 iterative degradation | 0 / 3 wired | Per-session sequences requiring 20-edit chains; meaningful only with a real model. |
| §6.1 fidelity report (with ΔS/ΔT vs baseline) | basic only | Current TSV captures per-scenario aggregates; baseline subtraction (rwa-edit/1 vs v0.x wholesale path) not wired up. |
| §6.2 operational report | basic only | Tokens + wall_ms recorded but not yet rendered as a separate table. |
| §6.4 multi-model portability | not wired | Runner can run against any single model; multi-model orchestration (3 reference classes) is not yet a single command. |
| §9 self-calibration | not run | Calibration rwa-edit/1 vs baseline gate is in the spec but not yet enforced. |
| §10 reference models | not declared | `models.json` is not present. |
| §11 mechanical-vs-perceived correlation study | not in scope | Requires human review. |
| §12 fixture catalog | 2 / 45 fixtures | `article-medium/{clean,clean-rich}` only. The other 43 fixture variants from spec §12.4 + §12.3 wear levels are deferred. |

All of these are additive — none require runtime changes. Adding a
fixture is a `.html` file; adding a scenario is an `.mjs` file matching
the existing shape; adding a baseline runner is one new file in
`runners/`; multi-model orchestration is iteration over an array.

## How to reproduce

```sh
# Conformance only (no API key needed)
cd benchmark
npm install
npm run conformance       # 42 / 42 passing

# Fidelity with stub
npm run fidelity:stub     # 9 / 9 at S=2/T=2/drift=0

# Fidelity with real model (needs OpenRouter)
RWA_OPENROUTER_KEY=sk-or-... node runners/run-fidelity.mjs google/gemini-3-flash-preview

# Oracle self-tests
npm run test:oracles      # 16 / 16 passing

# Existing e2e suite (independent of benchmark/)
cd ../tests
npm install
npm test                  # 266 / 266 passing
```

Final stdout of each runner ends with the metric (passing count) on its
own line — suitable as the verify command for autoresearch.
