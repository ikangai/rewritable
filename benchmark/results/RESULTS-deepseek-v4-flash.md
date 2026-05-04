# Real-model fidelity run — `deepseek/deepseek-v4-flash`

**Run date:** 2026-05-04
**Model:** `deepseek/deepseek-v4-flash`
**Scenarios:** 80 fidelity scenarios across 13 categories, N=1-3 each
**Tokens (estimated):** ~611K input
**Wall time:** ~30 minutes (notably slower than gemini-3.1-flash-lite)

## Headline

| Metric | deepseek-v4-flash | gemini-3.1-flash-lite | Δ |
|---|---|---|---|
| Overall mean S | 1.60 | 1.63 | -0.03 |
| Overall mean T | 1.23 | 1.27 | -0.04 |
| Both S=T=2 | 29 / 80 (36.2%) | 34 / 80 (42.5%) | -5 |
| S=2 perfect | 51 / 80 (63.8%) | 56 / 80 (70.0%) | -5 |
| T=2 perfect | 39 / 80 (48.8%) | 45 / 80 (56.2%) | -6 |
| S=0 outright fail | 7 / 80 | 7 / 80 | = |
| T=0 measurable drift | 18 / 80 | 23 / 80 | -5 |
| Median wall per call | ~12 s | ~870 ms | **~14×** |
| Approx input tokens | 611K | 554K | +10% |

The two models produce **near-identical fidelity**, but deepseek-v4-flash is **~14× slower** per call. Same overall S/T, similar total token cost, very different latency.

## Per-category breakdown

| Category | n | meanS | meanT | avg drift | wall_med (ms) |
|---|---|---|---|---|---|
| APP | 6 | 2.00 | 2.00 | 0.00 | 58 (customRun, no model) |
| INTERACT | 6 | 2.00 | 2.00 | 0.00 | 62 (customRun) |
| DEG | 3 | 1.67 | 2.00 | 0.00 | 21,228 |
| DATA | 6 | 1.83 | 1.11 | 0.24 | 9,112 |
| ID | 6 | 1.83 | 0.67 | **0.37** | 11,746 |
| CONT | 7 | 1.81 | 0.86 | 0.27 | 26,800 |
| ROB | 8 | 1.75 | 1.33 | 0.20 | 10,814 |
| PRES | 6 | 1.72 | 0.78 | 0.17 | 19,855 |
| GENRE | 6 | 1.72 | 1.00 | 0.11 | 15,735 |
| INTL | 7 | 1.57 | 0.57 | **0.42** | 20,404 |
| FID | 6 | 1.56 | 1.67 | 0.003 | 12,647 |
| BULK | 4 | 1.25 | 1.67 | 0.13 | 18,292 |
| FAIL | 9 | **0.44** | 1.04 | 0.51 | 14,125 |

## Comparison to gemini-3.1-flash-lite

The two models bias differently per category:

| Category | gemini meanS | deepseek meanS | gemini meanT | deepseek meanT | Δ T |
|---|---|---|---|---|---|
| FID | 1.83 | **1.56** | 1.67 | 1.67 | = |
| PRES | 1.72 | 1.72 | 1.44 | **0.78** | -0.66 |
| ID | 1.83 | 1.83 | 1.00 | **0.67** | -0.33 |
| CONT | 1.95 | 1.81 | 0.38 | **0.86** | **+0.48** |
| DATA | 1.83 | 1.83 | 1.22 | 1.11 | -0.11 |
| BULK | 1.25 | 1.25 | 1.50 | **1.67** | +0.17 |
| ROB | 1.75 | 1.75 | 1.42 | 1.33 | -0.09 |
| INTL | 1.52 | 1.57 | 1.05 | **0.57** | -0.48 |
| GENRE | 1.83 | 1.72 | 0.33 | **1.00** | **+0.67** |
| FAIL | 0.44 | 0.44 | 1.11 | 1.04 | -0.07 |
| DEG | 1.67 | 1.67 | 2.00 | 2.00 | = |

**Notable:**
- **deepseek wins on CONT and GENRE** stability — these are scenarios with multiple coupled edits where it's less likely to reflow surrounding prose
- **gemini wins on PRES, ID, INTL** stability — deepseek tends to drift more on presentation invariants and non-Latin
- **FID success drops** for deepseek (1.83 → 1.56) — it's slightly less reliable on simple typo/paragraph edits

Neither model meets spec §6.5 production-ready thresholds (meanS ≥ 1.7, meanT ≥ 1.8). They sit in the "small/lite stress-test class" envelope.

## Notable per-scenario behavior

**Both models perfect (S=T=2):**
APP-* / INTERACT-* (customRun, runtime mechanics — not model)
FID-01, FID-03, FID-04, FID-05
PRES-04, PRES-05, PRES-06 (inline elements, table cell, spacing classes)
ID-02 (aria-labelledby), ID-03 (anchor link)
DATA-02, DATA-04 (CSV append, code-block byte identity)
ROB-02, ROB-05, ROB-06, ROB-08 (CRLF, near-cap, ambiguous-anchor, decline)
INTL-02 (Hebrew + brand)
DEG-02, DEG-03 (reproducibility, save round-trip)
FAIL-05, FAIL-07 (concurrent_modify, multi-turn happy path)

**deepseek-only correct:** GENRE-04 (letter — recipient-name propagation handled cleaner than gemini)

**gemini-only correct:** CONT-04 (kg/lbs dual-unit update)

## Operational

- **Wall time:** deepseek-v4-flash is consistently ~10-25 seconds per call vs gemini's ~870ms. **Single biggest difference between the two models.**
- **Cost:** approximately equivalent in input tokens; deepseek's pricing (per OpenRouter) was higher than gemini-flash-lite — exact $ depends on pricing at run time.
- **No retries observed** in either run (rwa-edit/1's 3-retry budget not exercised — both models produce valid envelopes on first try across this scenario set).

## Reproduce

```sh
cd benchmark
node --env-file=../.env runners/run-fidelity.mjs deepseek/deepseek-v4-flash
```

Output snapshot: `results/fidelity.deepseek-v4-flash.tsv` and `results/run-deepseek-v4-flash.log`.

## Multi-model context

| Model | meanS | meanT | wall (med) | both perfect |
|---|---|---|---|---|
| stub (harness baseline) | 2.00 | 2.00 | 60ms | 80/80 |
| gemini-3.1-flash-lite | 1.63 | 1.27 | 870ms | 34/80 |
| deepseek-v4-flash | 1.60 | 1.23 | 12s | 29/80 |
| (frontier-class — not yet run) | — | — | — | — |

Run `node --env-file=../.env runners/multimodel.mjs --models=anthropic/claude-opus-4-7,anthropic/claude-sonnet-4-6,anthropic/claude-haiku-4-5` to compare frontier/mid/small in one go (spec §6.4 portability).
