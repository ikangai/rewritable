# Benchmark state

**Conformance: 86 / 86** | **Fidelity: 108 scenarios (all S=2 / T=2 / drift=0 with stub)** | **Oracle self-tests: 44 / 44** | **Drift detectors proven alive: 91 / 108** (17 declared no-drift-dimension, 0 unprobed, 0 dead) | **Context cost: ratcheted**

## 2026-08-27 — the graders got gates

Everything below this section describes the suite as of May 2026 and its
headline numbers were stale by 44 conformance and 28 fidelity scenarios. The
counts above are current; the historical narrative is kept as written.

What changed, and why it mattered:

- **`npm run test:oracles` never ran in CI.** The 44 assertions covering
  `computeDrift` / `discretizeStability` — the graders every other number in
  this file depends on — were only ever run by hand. Now the first step of the
  benchmark job.
- **The drift oracle's negative control covered 1 scenario in 108.** Only
  `fid-01` ever defined a `baselineDoc`, and `selectModel` silently fell back
  to the *stub* — the perfect model — for the other 107. So `fidelity:baseline`
  replayed the good model 107 times and reported meanS=2.00 / meanT=1.98 /
  drift=0.0000, which reads as "models are fine" rather than "this lane
  measures nothing". Under the stub the correct drift is 0, so a `computeDrift`
  that unconditionally returned 0 would have passed the entire suite green.
- **`npm run fidelity:control` is the fix** — a per-scenario negative control
  that perturbs each scenario's own input outside the declared edit region and
  requires that scenario's own oracle to notice. 91 of 108 now proven alive.
  A scenario that stays silent must declare why (`driftProbe`), and an
  undeclared silent oracle fails the build. Three probe families, because
  three oracle shapes exist: doc-based (`computeDrift`), envelope-based
  (`computeDriftFromEdits` — which ignores the doc, and which strips the
  common prefix/suffix between find and replace, so a probe must REPLACE
  bytes rather than append them), and `customRun` (scored off the object
  the scenario returns, probed by running it for real and corrupting that).
- **`fidelity:baseline` now runs only what it has calibrated** (1 scenario) and
  says out loud how many it dropped, instead of averaging in 107 copies of the
  perfect model.
- **17 scenarios were voting on a dimension they do not measure.** Their
  stability oracle is a hardcoded `score: 2` (they assert runtime behaviour or
  `tool_result` payload shape, not document bytes). That free 2.0 was inflating
  `meanT` in every run this suite has ever recorded. They are now excluded from
  the stability aggregates and still counted in S, which they do measure.
- **`median_drift` was structurally blind.** Over a suite where most scenarios
  are legitimately 0 it can never move — it printed 0.0000 on a run where
  `meanT` had visibly dropped. Headline is now **zero-drift rate** + **p95
  drift** + **perfect-run rate**; the median is kept as a footnote.
- **`retry_rounds` was computed per run and discarded.** A model that only lands
  it on attempt 3 costs 3× the tokens and 3× the latency of one that lands it
  first, and scored identically on every other number here. Now reported.
- **Context cost had no gate.** `tokens_in` was captured since this runner was
  written and used for nothing. `npm run cost:check` ratchets suite prompt size
  against `baselines/context-cost.json` (±3% suite, ±10% per scenario). Under
  the stub, `tokens_in` is measured over the REAL system prompt and tool
  schemas, so it is model-free and still moves exactly when the prompt does.
- **`N: 1` under a real model was a trap.** 14 scenarios shipped it — one
  carrying the comment *"deterministic with stub; for real model bump to 10"*,
  a note-to-self that never became behaviour. N is now model-aware: 1 under the
  deterministic stub, ≥3 under a real model, overridable per scenario via
  `Nreal`.

DEG-02 was briefly left UNPROBED and is now closed: its `scoreAfterCustom`
reads only `out.endpoint1 === out.endpoint2`, so the probe runs the scenario
through the real runtime and corrupts an endpoint — the score drops 2→0, and
the detector is proven. **0 scenarios remain unprobed, 0 dead.**

---

This file replaces the earlier "9 fidelity scenarios scaffolded" report. The benchmark now covers the entire v1.3 spec surface — every scenario in §4 (fidelity, 80) and §5b (conformance, 42), the operational instrumentation in §2.4, the calibration gate in §9, the multi-model orchestration scaffold in §6.4, and a curated subset of the §12 fixture catalog. Every spec-vs-runtime gap surfaced by the suite has been closed in `seeds/rewritable.html`.

## Coverage by category (spec v1.3 §4 + §5b)

### Conformance — 42 / 42 passing

| Subcategory | Wired | Total | Notes |
|---|---|---|---|
| CONFORM (failure codes) | 16 | 16 | One per code in spec §10 |
| SHAPE (rules 9 + 10) | 1 | 1 | Multi-turn retry on shape rejection |
| ATOM (rule 3) | 1 | 1 | Validation-before-apply atomicity |
| SEQ (rule 6) | 1 | 1 | Sequential application against working copy |
| BOOTSTRAP (rule 1) | 1 | 1 | Bootstrap inviolability |
| AUDIT (§12 hist shape) | 2 | 2 | edit_batch + replace_document records |
| MUTEX (rule 8) | 1 | 1 | Caller-held lock visibility |
| SNAPSHOT (container §11) | 4 | 4 | Bootstrap byte-identity across edits |
| AUTHOR (§7.2) | 5 | 5 | Frozen-zone evolution via external editing |
| EDGE (op edge cases) | 10 | 10 | Whitespace/large/UTF-16 boundary/IDB abort/etc. |

### Fidelity — 80 / 80 wired

| Category | Wired | Pass | Total | Notes |
|---|---|---|---|---|
| FID core fidelity | 6 | 6 | 6 | Anti-drift on single-edit operations |
| PRES presentation | 6 | 6 | 6 | @page, hierarchy, table, classes |
| ID identity | 6 | 6 | 6 | ids, aria, label-for, frozen zones |
| CONT content | 7 | 7 | 7 | Counts, footnotes, totals, dual units, TOC, cross-refs, templates |
| DATA embedded data | 6 | 6 | 6 | JSON, CSV, SVG, code blocks, regex, textarea |
| APP application state | 6 | 6 | 6 | renderDoc now preserves id-keyed form state |
| BULK bulk ops | 4 | 4 | 4 | Translation tool-trace, mass refactor |
| ROB robustness | 8 | 8 | 8 | Edge anchors, locale, unicode, decline |
| INTL internationalization | 7 | 7 | 7 | RTL, CJK, mixed-script, locale numbers |
| INTERACT interaction | 6 | 6 | 6 | Drag-drop, shortcut, dialog, scroll, wizard |
| GENRE document genres | 6 | 6 | 6 | Form, spreadsheet, deck, letter, clock, press release |
| FAIL failure UX | 9 | 9 | 9 | Tool_result payload, retry exhaustion, decline, mixed-failure |
| DEG degradation | 3 | 3 | 3 | 20-edit sequence, reproducibility, save round-trip |

**Headline numbers (stub model, N=1-3 per scenario):**
- Overall mean S = 2.00 (80 / 80 perfect)
- Overall mean T = 2.00
- Median drift_ratio = 0.0000

## Runtime fixes that landed during this loop

All in `seeds/rewritable.html`. Each fix was guarded by `tests/e2e.mjs` (no regressions) and verified against the relevant benchmark scenarios:

1. **`computeShape` distinct top-level types** — set-based, allows splitting `<p>` while rejecting `<section>` introduction. Catches CONFORM-11.
2. **Token-level `<script>`/`<style>` balance** — catches the truncated-script case where the HTML5 parser auto-closes silently. Catches CONFORM-10.
3. **`concurrent_modify` structured throw** — `modify()` now throws `RwaEditError('concurrent_modify')` instead of returning `undefined` after a UI flash. Catches CONFORM-14 + FAIL-05.
4. **UTF-16 well-formedness** — `String.prototype.isWellFormed()` validation on every find/replace/doc/reason. Catches EDGE-05.
5. **renderDoc id-keyed form state preservation** — captures `<input>`/`<textarea>`/`<select>` values + `<details open>` by id before innerHTML replacement, restores after. Catches APP-01 + APP-02.

## Orchestration runners

```
benchmark/runners/
├── harness.mjs            # jsdom + isolated fake-indexeddb per scenario
├── run-conformance.mjs    # 42 deterministic scenarios — no model needed
├── run-fidelity.mjs       # model-in-loop, supports 'stub' / 'baseline' /
│                            real model name (passed as argv)
├── calibrate.mjs          # spec §9 self-calibration gate (v1 vs baseline)
├── multimodel.mjs         # spec §6.4 multi-model orchestration
├── model.mjs              # stubModel + baselineModel + openRouterModel
└── score.mjs              # TSV + summary writer
```

```
benchmark/oracles/
├── diff.mjs               # drift_ratio: single-hunk + envelope-based
├── selector.mjs           # CSS selector assertions, scored 0/1/2
└── *.test.mjs             # 16 self-tests
```

## Calibration result (spec §9)

Today's calibration on FID-01:
- v1 (rwa-edit/1): meanS=2.00, meanT=2.00, median drift_ratio=0.0000
- baseline (v0.x wholesale rewrite): meanS=2.00, meanT=0.00, median drift_ratio=0.9407
- baseline drift / v1 drift = ∞
- **Result: PASSED** — benchmark distinguishes v1 from baseline as the spec requires.

The other six calibration scenarios (FID-02..06 + DEG-01) don't yet have `baselineDoc` declared. Adding one is a hand-crafted exercise of "what the v0.x model would have emitted." FID-01's example shows the expected divergence pattern (correct edit + drift across surrounding prose).

## Fixture catalog (spec §12)

`fixtures/manifest.json` declares 8 fixture files across 6 templates today. Most fidelity scenarios use inline `fixtureContent` declared in the `.mjs` file rather than a tracked `.html` — pragmatic for this iteration; the structured catalog is reserved for spec-strict reproducibility. See `_deferred_templates` and `_deferred_wear_levels` in the manifest for what remains.

## How to run

```sh
cd benchmark
npm install
npm run conformance       # 42 / 42 (no API key)
npm run fidelity:stub     # 80 / 80 wired (78 pass with stub)
npm run fidelity:baseline # baseline path (compares as ΔS/ΔT vs v1)
npm run calibrate         # §9 calibration gate
npm run multimodel        # iterate models from models.json (stub-only without keys)
npm run test:oracles      # 16 / 16 oracle self-tests

# Real model:
RWA_OPENROUTER_KEY=sk-or-... node runners/run-fidelity.mjs anthropic/claude-sonnet-4-6
```

Final stdout of each runner ends with the metric (passing count or aggregate) on its own line — the autoresearch loop's keep/discard signal.

## What remains (purely additive — no spec or runtime gaps)

- **Fixture catalog completion**: ~7 of the 15 spec §12.4 templates not yet represented (article-long, form-tax-return, spreadsheet-budget, slide-deck, letter-invitation, clock-realtime, press-release, tutorial-rwa, unicode-heavy, mixed-script). Lived-in/messy variants exist only for article-medium. Each is a small hand-authored HTML file.
- **Per-scenario `baselineDoc`**: only FID-01 has one today. The other 79 need one each to participate in calibration / baseline subtraction. Mechanical — write what the v0.x model would have output.
- **Multi-model real runs**: `multimodel.mjs` iterates models but is meaningful only with a real OpenRouter key. The orchestration is wired up.
- **Per-§6.5 production-ready thresholds**: `mean S ≥ 1.7`, `mean T ≥ 1.8`, `median drift ≤ 0.005`, `DEG-01 mean T ≥ 1.5` etc. — gating script not yet automated; the data is in `results/fidelity.tsv` so a small script can compute pass/fail.
- **Correlation study (spec §11)**: human review of mechanical scores for 20 scenarios. Out of scope for any agent-only loop.

All five items are purely additive. None require runtime changes. The benchmark mechanics are complete: oracles, runners, calibration, multi-model orchestration, all 122 scenarios from spec §4 + §5b.
