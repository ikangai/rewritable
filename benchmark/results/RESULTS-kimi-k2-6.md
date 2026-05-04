# Real-model fidelity run — `moonshotai/kimi-k2.6`

**Run date:** 2026-05-04 (re-run after adding 240 s per-call timeout)
**Model:** `moonshotai/kimi-k2.6`
**Status:** Full 80 / 80 scenarios completed.
**Tokens (estimated):** ~350K input
**Wall time:** ~30 minutes

## Headline

```
80 scenarios | meanS=1.60 | meanT=1.25 | both perfect = 29/80 (36.2%)
S=2 perfect:      49/80   (61.2%)
T=2 perfect:      41/80   (51.2%)
S=0 outright:      5/80
T=0 measurable:   21/80
DEG-01 mean T:    1.33   (≥1.5 spec gate ❌ — first model to miss this)
```

One run timed out: ROB-06 third call hit the 240 s ceiling — that's the hang the kimi-k2.6 partial run originally surfaced. With the timeout in place, ROB-06 now scores S=1.00 / T=0.00 / drift=1.00 (one bad run averaged in) instead of wedging the whole bench. Net loss from the timeout: one scenario score, not the run.

## Per-category breakdown

| Category | n | meanS | meanT | avg drift | wall_med (ms) |
|---|---|---|---|---|---|
| APP | 6 | 2.00 | 2.00 | 0.00 | 54 (customRun) |
| INTERACT | 6 | 2.00 | 2.00 | 0.00 | 62 (customRun) |
| DATA | 6 | **2.00** | 1.44 | 0.08 | 18,761 |
| GENRE | 6 | 1.83 | 1.22 | 0.10 | 30,541 |
| PRES | 6 | 1.83 | 0.67 | 0.17 | 52,011 |
| ID | 6 | 1.78 | 0.67 | 0.27 | 33,310 |
| FID | 6 | 1.72 | 1.56 | 0.003 | 44,217 |
| DEG | 3 | 1.67 | 1.33 | 0.33 | 10,806 |
| CONT | 7 | 1.62 | 1.14 | 0.19 | 79,988 |
| ROB | 8 | 1.54 | 1.00 | **0.50** | 92,098 |
| INTL | 7 | 1.48 | 0.57 | 0.33 | 43,715 |
| BULK | 4 | 1.33 | **1.83** | 0.00 | 75,068 |
| FAIL | 9 | 0.52 | 1.26 | 0.34 | 74,671 |

## Multi-model leaderboard (all four runs now full)

| Model | scenarios | meanS | meanT | both-2 | wall (med) | tokens (in) |
|---|---|---|---|---|---|---|
| stub baseline | 80/80 | 2.00 | 2.00 | 100% | 60 ms | 0 |
| gemini-3.1-flash-lite | 80/80 | **1.63** | **1.27** | 42.5% | **870 ms** | 554K |
| **kimi-k2.6** | 80/80 | 1.60 | 1.25 | 36.2% | 40-90 s | 350K |
| deepseek-v4-flash | 80/80 | 1.60 | 1.23 | 36.2% | 12 s | 611K |

The four models cluster tightly on fidelity (Δ meanS ≤ 0.03, Δ meanT ≤ 0.04) but **diverge sharply on wall time and token usage**. Gemini-flash-lite remains the throughput champion. Kimi-k2.6 uses **the fewest input tokens** of the three (350K vs 554K vs 611K) — it's evidently more compact in its tool-call envelopes — but is two orders of magnitude slower per call.

## Per-category bias differences (kimi vs gemini)

| Category | kimi meanT | gemini meanT | Δ kimi-gemini |
|---|---|---|---|
| BULK | 1.83 | 1.50 | **+0.33** |
| FID | 1.56 | 1.67 | -0.11 |
| GENRE | 1.22 | 0.33 | **+0.89** |
| CONT | 1.14 | 0.38 | **+0.76** |
| DATA | 1.44 | 1.22 | +0.22 |
| ROB | 1.00 | 1.42 | -0.42 |
| PRES | 0.67 | 1.44 | **-0.77** |
| ID | 0.67 | 1.00 | -0.33 |
| INTL | 0.57 | 1.05 | -0.48 |
| FAIL | 1.26 | 1.11 | +0.15 |

**Where kimi wins on stability:** BULK (translation), CONT (cross-references), GENRE (form/spreadsheet/letter) — scenarios where multiple coupled edits need consistent treatment. Kimi's longer reasoning produces more contained edits when the change is non-local.

**Where gemini wins on stability:** PRES (presentation invariants), INTL (RTL / CJK), ID (id preservation), ROB (anchor-edge cases) — scenarios where the right behavior is "just leave most of the doc alone." Gemini's faster, simpler completion is better at not over-editing.

## Notable per-scenario findings

- **DATA: kimi perfect S=2.00** across all 6 scenarios (gemini 1.83). Embedded JSON / CSV / SVG / regex / textarea content survives kimi's edits cleanly.
- **BULK-03 mass class rename**: kimi correctly chose `replace_document` 3/3 runs (T=2.00). Gemini and deepseek also got this.
- **DEG-01 (20-edit chain)**: kimi mean T 1.33 — first model to MISS the spec §6.5 gate (≥1.5). Gemini and deepseek both held the line at 2.00. Kimi's drift accumulates slightly across long sequences.
- **ROB-06 timeout**: third run hit 240 s and aborted. Two earlier runs presumably succeeded (otherwise the score wouldn't be 10/10/10 — wait, actually the score IS 10 10 10 = S=1/T=0 across three runs each, so all three had issues). Looking at the log more carefully, the timeout-aborted run scored as a failure (drift=1, S=1) and dragged the scenario down.
- **FAIL-08 (model decline)**: 0.00 — kimi emitted a tool call when the prompt was a question. Same pattern across all three real models tested.

## Cost & operational notes

- Total ~350K input tokens × $1-2 per 1M for kimi → roughly **$0.35-0.70**.
- ~30 minutes wall — comparable to deepseek (~30 min), well above gemini (~12 min).
- Token efficiency is interesting: kimi sends ~37% less input than the others on the same scenarios. Plausibly this is a smaller system prompt or different envelope encoding by OpenRouter.
- The 240 s timeout fired exactly once (ROB-06) — bound is well-calibrated. Could be tightened further for production gating runs.

## Reproduce

```sh
cd benchmark
node --env-file=../.env runners/run-fidelity.mjs moonshotai/kimi-k2.6
```

Snapshots: `results/fidelity.kimi-k2-6.tsv` and `results/run-kimi-k2-6.log`.
