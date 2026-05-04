# Real-model fidelity run — `moonshotai/kimi-k2.6` **(partial — 60/80)**

**Run date:** 2026-05-04
**Model:** `moonshotai/kimi-k2.6`
**Status:** **Run hung mid-INTL-02 after 60 / 80 scenarios.** No throughput on the API call for ~30 minutes; killed manually. The 60 completed scenarios are reported below.

## What happened

The runtime's `fetch()` to OpenRouter has no client-side timeout. Kimi K2.6 occasionally produced very long completions on this run (the most expensive scenarios in the partial result hit ~2.5 minutes wall time and 5,500 tokens), and the third call of INTL-02 either silently stalled mid-response or queued behind a provider-side rate limit. After 30 min of zero progress the run was killed. Adding a per-call timeout to the runtime fetch (e.g. 90 s) is the obvious next harness improvement.

## Headline (60 scenarios, partial)

| Metric | kimi-k2.6 (partial) | gemini-3.1-flash-lite | deepseek-v4-flash |
|---|---|---|---|
| Scenarios | 60 / 80 | 80 / 80 | 80 / 80 |
| Mean S | 1.63 | 1.63 | 1.60 |
| Mean T | **1.38** | 1.27 | 1.23 |
| Both S=T=2 | 43.3% (26/60) | 42.5% (34/80) | 36.2% (29/80) |
| S=2 perfect | 66.7% | 70.0% | 63.8% |
| T=2 perfect | 56.7% | 56.2% | 48.8% |
| Median wall / call | varies (40-150s) | 870 ms | 12 s |

Even on the partial run, **kimi-k2.6 has the best mean T** of the three small-class models tested — slightly better stability than gemini, considerably better than deepseek. Mean S is essentially identical to gemini (1.63 = 1.63). The trade-off is **wall time**: kimi-k2.6 averages tens of seconds per call where gemini averages under one.

## Per-category breakdown (partial)

| Category | n | meanS | meanT | avg drift | wall_med (ms) |
|---|---|---|---|---|---|
| APP | 6 | 2.00 | 2.00 | 0.00 | 52 (customRun) |
| INTERACT | 6 | 2.00 | 2.00 | 0.00 | 62 (customRun) |
| DATA | 6 | **2.00** | 1.11 | 0.13 | 25,250 |
| DEG | 3 | 1.67 | 2.00 | 0.00 | 19,388 |
| CONT | 7 | 1.86 | 0.95 | 0.14 | 90,887 |
| FID | 6 | 1.83 | 1.55 | 0.003 | 91,245 |
| ID | 6 | 1.72 | 0.89 | 0.13 | 21,609 |
| GENRE | 6 | 1.72 | 1.22 | 0.15 | 23,108 |
| BULK | 4 | 1.42 | 1.50 | 0.13 | 45,166 |
| FAIL | 9 | 0.59 | 1.26 | 0.29 | 63,231 |
| INTL | 1/7 | 1.00 | 0.00 | 0.33 | 57,581 |
| **PRES, ROB** | 0/14 | — | — | — | (not run) |

The hang prevented INTL-02..07, PRES-01..06, and ROB-01..08 — 20 model-driven scenarios. Categories that completed show a different bias than the prior two models: kimi gets DATA scenarios *perfectly correct* (S=2.00 across 6) and CONT *better* (meanT 0.95 vs gemini 0.38, deepseek 0.86), but its FID success rate is comparable to others.

## Multi-model leaderboard so far

| Model | scenarios | meanS | meanT | both-2 | wall (med) | tokens (in) |
|---|---|---|---|---|---|---|
| stub baseline | 80/80 | 2.00 | 2.00 | 100% | 60ms | 0 |
| **kimi-k2.6 (partial)** | **60/80** | **1.63** | **1.38** | **43.3%** | **40-90s** | 279K |
| gemini-3.1-flash-lite | 80/80 | 1.63 | 1.27 | 42.5% | 870ms | 554K |
| deepseek-v4-flash | 80/80 | 1.60 | 1.23 | 36.2% | 12s | 611K |

On the 60 scenarios where kimi completed, it outperformed both other models on mean T (1.38 vs 1.27, 1.23). The 20 missing scenarios are categorically what bothered the run — long-running edits in INTL/PRES/ROB.

## Action items

1. **Add a per-call timeout** to `seeds/rewritable.html` `modify()`'s fetch (e.g. 120 s) or to the benchmark's `model.mjs` fetch wrapper. Then re-run kimi-k2.6 to get the missing 20 scenarios.
2. **Investigate INTL-02** under kimi-k2.6 specifically — the third run hung. Could be a provider artifact, a rate-limit, or the model entering a long thinking loop on Hebrew + English brand text.
3. **Frontier comparison** still pending — once timeout is added, run claude-opus-4-7 / gpt-5 / gemini-3-pro for the §6.4 portability table.

## Reproduce (until the timeout fix)

```sh
cd benchmark
node --env-file=../.env runners/run-fidelity.mjs moonshotai/kimi-k2.6
# may hang on INTL-02 — kill manually if no log progress for ~5 min
```
