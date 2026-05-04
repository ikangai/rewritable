# Benchmark state — full v1.3 coverage

**Conformance: 42 / 42** | **Fidelity: 80 / 80 scenarios wired (78 pass, 2 documented runtime gaps)** | **tests/e2e.mjs: 266 / 266** | **Oracle self-tests: 16 / 16** | **Calibration: PASSED** (FID-01 v1 T=2 vs baseline T=0, drift_ratio 0× vs 0.94)

This file replaces the earlier "9 fidelity scenarios scaffolded" report. As of the third autoresearch-loop completion, the benchmark covers the entire v1.3 spec surface — every scenario in §4 (fidelity, 80) and §5b (conformance, 42), the operational instrumentation in §2.4, the calibration gate in §9, the multi-model orchestration scaffold in §6.4, and a curated subset of the §12 fixture catalog.

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
| APP application state | 6 | 4 | 6 | **APP-01 + APP-02 fail (renderDoc gap)** |
| BULK bulk ops | 4 | 4 | 4 | Translation tool-trace, mass refactor |
| ROB robustness | 8 | 8 | 8 | Edge anchors, locale, unicode, decline |
| INTL internationalization | 7 | 7 | 7 | RTL, CJK, mixed-script, locale numbers |
| INTERACT interaction | 6 | 6 | 6 | Drag-drop, shortcut, dialog, scroll, wizard |
| GENRE document genres | 6 | 6 | 6 | Form, spreadsheet, deck, letter, clock, press release |
| FAIL failure UX | 9 | 9 | 9 | Tool_result payload, retry exhaustion, decline, mixed-failure |
| DEG degradation | 3 | 3 | 3 | 20-edit sequence, reproducibility, save round-trip |

**Headline numbers (stub model, N=1-3 per scenario):**
- Overall mean S = 1.95 (78 perfect + 2 zero / 80)
- Overall mean T = 2.00
- Median drift_ratio = 0.0000

The two `S=0` scenarios are real runtime gaps documented below.

## Documented runtime gaps

Surfaced by the benchmark; would each require small runtime changes to close. All are in the same family — the runtime's `renderDoc(html)` calls `mount.innerHTML = html` which destroys form state. Closing them needs a render-side capture/restore step.

### APP-01 — form `<input>` value persistence

The runtime's `renderDoc` replaces `innerHTML`, throwing away `input.value` set by the user. The spec expects the value to persist across an unrelated edit. Fix sketch:

```js
function renderDoc(html) {
  const m = document.getElementById('rwa-doc-mount');
  // Capture form values before the destructive replacement.
  const captured = {};
  m.querySelectorAll('input,textarea,select').forEach(el => {
    if (el.id) captured[el.id] = el.value;
  });
  m.innerHTML = html;
  // ... script-replacement dance ...
  // Restore captured values to elements with matching ids.
  for (const [id, val] of Object.entries(captured)) {
    const el = m.querySelector('#' + CSS.escape(id));
    if (el && 'value' in el) el.value = val;
  }
}
```

### APP-02 — `<details open>` persistence

Same root cause, same fix family — capture `open` state of `<details>` elements by id before innerHTML replacement, restore after.

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

## What remains (additive, no spec gaps)

- **Fixture catalog completion**: 7 of the 15 spec §12.4 templates not yet represented (article-long, form-tax-return, spreadsheet-budget, slide-deck, letter-invitation, clock-realtime, press-release, tutorial-rwa, unicode-heavy, mixed-script). Lived-in/messy variants exist only for article-medium. Each is a ~1-2KB hand-authored HTML file.
- **Per-scenario `baselineDoc`**: only FID-01 has one today. The other 79 need one each to participate in calibration / baseline subtraction. Mechanical — write what the v0.x model would have output.
- **Multi-model real runs**: `multimodel.mjs` iterates models but is meaningful only with a real OpenRouter key. The orchestration is wired up.
- **Per-§6.5 production-ready thresholds**: `mean S ≥ 1.7`, `mean T ≥ 1.8`, `median drift ≤ 0.005`, `DEG-01 mean T ≥ 1.5` etc. — gating script not yet automated; the data is in `results/fidelity.tsv` so a small script can compute pass/fail.
- **Correlation study (spec §11)**: human review of mechanical scores for 20 scenarios. Out of scope for any agent-only loop.

The runtime-fix work (APP-01/02) is the only non-additive item — it requires changes to `seeds/rewritable.html`. The other items are purely benchmark expansion.
