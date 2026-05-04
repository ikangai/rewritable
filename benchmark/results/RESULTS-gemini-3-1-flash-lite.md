# Real-model fidelity run — `google/gemini-3.1-flash-lite-preview`

**Run date:** 2026-05-04
**Model:** `google/gemini-3.1-flash-lite-preview` (small/lite class per spec §10)
**Scenarios:** 80 fidelity scenarios across 13 categories, N=1-3 each
**Tokens (estimated):** ~554K input, runtime ~12 minutes, total cost ~$0.07

## Headline

| Metric | Value | Spec §6.5 production-ready threshold |
|---|---|---|
| Overall mean S | **1.63** | ≥ 1.7 ❌ |
| Overall mean T | **1.27** | ≥ 1.8 ❌ |
| Both S=T=2 (perfect) | 34 / 80 (42.5%) | — |
| S=2 perfect | 56 / 80 (70.0%) | — |
| T=2 perfect | 45 / 80 (56.2%) | — |
| S=0 outright failures | 7 / 80 | — |
| T=0 measurable drift | 23 / 80 | — |
| DEG-01 mean T | **2.00** | ≥ 1.5 ✅ |
| Wall time / scenario (median) | ~870 ms | — |

The model is the cheapest tier of Gemini 3.1; the production-ready thresholds in spec §6.5 are written for the *frontier* class. As a stress test of the model-portability claim (spec §10.2), the result confirms that the protocol works across capability levels but small models do drift.

## Per-category breakdown

| Category | n | mean S | mean T | avg drift | notes |
|---|---|---|---|---|---|
| APP | 6 | 2.00 | 2.00 | 0.00 | All customRun (runtime mechanics, no model) |
| INTERACT | 6 | 2.00 | 2.00 | 0.00 | All customRun |
| DEG | 3 | 1.67 | 2.00 | 0.00 | 20-edit chain stays clean |
| CONT | 7 | 1.95 | 0.38 | **0.36** | Model gets the change right but reflows surrounding prose — biggest drift category |
| GENRE | 6 | 1.83 | 0.33 | 0.23 | Same pattern as CONT — wholesale reflow |
| FID | 6 | 1.83 | 1.67 | 0.02 | Core anti-drift; near-clean |
| DATA | 6 | 1.83 | 1.22 | 0.08 | JSON/CSV/SVG/code mostly OK |
| ID | 6 | 1.83 | 1.00 | 0.09 | id-attribute preservation imperfect |
| ROB | 8 | 1.75 | 1.42 | 0.08 | Robustness solid |
| PRES | 6 | 1.72 | 1.44 | 0.07 | Presentation invariants hold mostly |
| INTL | 7 | 1.52 | 1.05 | 0.17 | RTL/CJK harder than English |
| BULK | 4 | 1.25 | 1.50 | 0.13 | Translation S drops; correct tool choice (apply_edits/replace_document) ~50% |
| FAIL | 9 | **0.44** | 1.11 | 0.38 | Most payload-shape assertions failed — see below |

## Notable per-scenario results (real model behavior under test)

**Perfect S=2 / T=2:**
- All FID-* except FID-02 (paragraph rewrite) and FID-06 (multi-edit batch)
- PRES-04/05/06 (inline elements, table cell, spacing classes)
- ID-02/03 (aria + anchor)
- DATA-02/04 (CSV append, code block byte-identical across translation)
- ROB-02/05/06/08 (CRLF, near-cap doc, ambiguous-anchor disambiguation, decline)
- INTL-02 (Hebrew + brand)
- DEG-02/03 (reproducibility, save round-trip)
- FAIL-05/07 (concurrent_modify, multi-turn happy path)
- All APP/INTERACT customRun scenarios

**S=2 / T=0 (correct edit, surrounding drift):**
- CONT-01 (six-reasons coupling) — drift 0.07
- CONT-02 (footnote insert) — drift **0.80** (model rewrote the whole `<ol>`)
- CONT-05/06/07 (cross-refs, templates) — moderate drift
- DATA-05/06 (regex, textarea) — drift 0.21-0.25
- INTL-05/06 (German numbers, Arabic+code) — drift 0.20-0.32
- GENRE-02/04/05/06 (spreadsheet, letter, clock, press release) — drift 0.17-0.52
- ROB-04 (template literals) — drift 0.23
- FID-06 multi-edit batch — drift 0.11
- ID-01/05 — drift 0.14-0.17

**S=0 (model didn't satisfy success oracle):**
- FAIL-01/02/06 — payload-shape assertions: model emitted valid envelopes that didn't trigger the *exact* failure code expected. These tests are over-specified.
- FAIL-03/04 — retry exhaustion: model produced a successful edit on at least one of the 3 retry slots, contradicting the test's assumption of consistent failure
- FAIL-08 — model didn't decline; emitted a tool call when the prompt was a question
- FAIL-09 — chained different failure codes didn't resolve in 3 turns

**Mixed/partial:**
- BULK-01..04 — translation/refactor success at S=1 (some assertions miss)
- DATA-03 — SVG path edit S=1 (the d-attribute rewrite was correct but selector check was strict)

## Operational instrumentation

- **Median tokens per modify call:** ~970 input / minimal output (mostly tool_call JSON)
- **p95 tokens:** ~2400 (multi-edit scenarios with larger envelopes)
- **Outlier:** ROB-05 (90%-of-cap fixture) used **116K input tokens** per run — the doc itself is ~900KB
- **Median wall time per scenario:** ~870 ms; max ~3.2 s for ROB-05
- **Total cost (Gemini 3.1 Flash Lite pricing):** ~$0.07 for the whole 80-scenario run

## Calibration cross-check (FID-01 only)

```
v1 (gemini-3.1-flash-lite, real):  S=2.00  T=2.00  drift=0.0000
baseline (wholesale rewrite stub): S=2.00  T=0.00  drift=0.9407
baseline / v1 drift ratio: ∞
```

Even on a small model, rwa-edit/1 produces ~0% drift while the v0.x wholesale-rewrite path produces ~94% drift on the same task. The protocol's central claim — that anchor-based edits preserve fidelity — holds with this model.

## What this run does and doesn't say

**Says:** A small/lite model can produce correct edits (S high) but tends to reflow surrounding text when the edit involves multiple coupled elements (CONT, GENRE) or non-Latin text (INTL). The drift is bounded — not catastrophic — but high enough that a frontier model should be the recommended class for production fidelity work.

**Doesn't say:** This is one model. Multi-model portability (spec §6.4) requires running the same scenarios against frontier and mid-tier models for comparison. Run `npm run multimodel` once you have keys/credits to compare classes.

## Reproduce

```sh
cd benchmark
node --env-file=../.env runners/run-fidelity.mjs google/gemini-3.1-flash-lite-preview
```

Output lands in `results/fidelity.tsv`; this run snapshotted to `results/fidelity.gemini-3-1-flash-lite.tsv` and `results/run-gemini-3-1-flash-lite.log`.
