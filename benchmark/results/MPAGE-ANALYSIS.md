# MPAGE batch — multipage-document fidelity scenarios

**Date:** 2026-05-20
**Batch size:** 10 scenarios (MPAGE-01..10)
**Model under test:** `google/gemini-3.5-flash` (current substrate default)
**Suite size after addition:** 108 scenarios (up from 98)

## What MPAGE covers

PRES-15 ships a real-world stack of paged-media invariants in one document.
MPAGE picks individual CSS Paged Media features and isolates each — so when a
regression hits, the cause is one specific feature, not "something in this
fixture."

| ID | Tag | Load-bearing thing | Failure mode it catches |
|---|---|---|---|
| MPAGE-01 | content | `@page :first` vs default `@page` | model collapses two @page rules into one, loses cover page |
| MPAGE-02 | content | `@page :left` + `@page :right` alternation | model symmetrizes book-style layout into one rule |
| MPAGE-03 | content | `string-set: chapter content()` + `string(chapter)` | model "tidies" unfamiliar `string-set` declaration |
| MPAGE-04 | content | edit the H1 that IS the string-set source | running-header rule preserved despite semantic content change |
| MPAGE-05 | structural_regular | TOC w/ manual page numbers (`vii`, `1`, `15`, `42`, `108`) | model "fixes" page numbers while editing a title |
| MPAGE-06 | content | `target-counter(attr(href), page)` cross-references | model removes unfamiliar `::after` rule |
| MPAGE-07 | content | `column-count: 2` + `column-span: all` on h2/figure | model flattens multi-column to single-column |
| MPAGE-08 | content | named pages: `@page frontmatter` (lower-roman) + `@page body` (arabic) | model unifies counter-style across the doc |
| MPAGE-09 | content | multi-chapter w/ `page-break-after: always` per chapter | model removes page-break rules it considers "unused" |
| MPAGE-10 | content | PDF outline: `bookmark-level/label/state` at h1/h2/h3 | model strips unfamiliar bookmark properties |

## Stub results (sanity check)

All 10 scenarios pass `meanS=2.00 meanT=2.00 drift=0.0000` on the stub. The
108-scenario stub run remains clean — no regression in the prior 98.

## Real-model results — `google/gemini-3.5-flash`

| ID | meanS | meanT | median_drift |
|---|---|---|---|
| MPAGE-01 | **2.000** | 0.000 | 0.140 |
| MPAGE-02 | **2.000** | 0.000 | 0.137 |
| MPAGE-03 | **2.000** | 0.000 | 0.153 |
| MPAGE-04 | **2.000** | **2.000** | **0.000** |
| MPAGE-05 | **2.000** | 0.000 | 0.106 |
| MPAGE-06 | **2.000** | 0.000 | 0.311 |
| MPAGE-07 | **2.000** | 0.000 | 0.159 |
| MPAGE-08 | **2.000** | 0.000 | 0.174 |
| MPAGE-09 | **2.000** | 0.000 | 0.194 |
| MPAGE-10 | **2.000** | 0.000 | 0.218 |

### Headline findings

1. **Perfect success across every scenario** — `meanS=2.00` on all 10. The
   model lands the requested edit every single time. CSS Paged Media features
   that the model didn't recognize (string-set, target-counter, bookmark-*)
   did not prevent it from finding the right anchor and performing the
   substitution.

2. **Zero stability on 9 of 10 scenarios** — `meanT=0.00`. The model is
   rewriting surrounding text, CSS rules, or both — exactly what the prompts
   explicitly told it not to do. Drift values land in the 0.10–0.31 range
   (10–31% of bytes outside the edit region change).

3. **MPAGE-04 is the lone outlier with `meanT=2.000 drift=0.0000`.** It edits
   one H1 element (`<h1 class="chapter">Chapter 2 — Composition</h1>` →
   `<h1 class="chapter">Chapter 2 — Composition and Glue</h1>`). The small
   surface area gives the model no room to "improve" surrounding content.

4. **MPAGE-06 has the highest drift (0.311).** Cross-reference scenario with
   two `<a class="xref">` elements in the edited paragraph. The model is
   tempted to tidy link markup when it sees it.

## Comparison: MPAGE vs PRES-10..15

| ID | meanS | meanT | drift | shape |
|---|---|---|---|---|
| PRES-10 | 1.000 | 0.000 | 0.141 | nested tables (structural) |
| PRES-11 | 1.667 | 0.000 | 0.125 | semantic header+article+footer |
| PRES-12 | 2.000 | 0.000 | 0.121 | surgical footer year change |
| PRES-13 | 2.000 | 0.000 | 0.091 | @media print rules preserved |
| PRES-14 | 2.000 | **0.667** | 0.056 | surgical @page size A4→Letter |
| PRES-15 | 2.000 | 0.000 | 0.113 | multi-section + @page margin-box + footer |
| **MPAGE-04** | **2.000** | **2.000** | **0.000** | edit H1 (tag-scope edit) |

The pattern reinforces: **the smaller the edit surface, the better the
stability score.** PRES-14 (one CSS declaration swap) and MPAGE-04 (one H1
text edit) are the only scenarios in this neighborhood with meaningful
stability. Every "edit a prose paragraph" scenario, regardless of how careful
the prompt is about preserving surroundings, drifts.

## Suite-wide context

`google/gemini-3.5-flash` overall on the 108-scenario suite:

- `meanS=1.68 meanT=0.69 median_drift=0.1469`
- Best tag: `runtime` (1 scenario, doesn't exercise the model)
- Best real tag: `mixed` for success (`meanS=1.95`) — coordinated edits land
- Worst stability tag: `mixed` (`meanT=0.19 drift=0.5631`) — coordinated edits
  drift the most outside the edit region
- Worst success tag: `failure_mode` (`meanS=0.53`) — expected, these test
  error paths

MPAGE's `meanS=2.000` average puts it at the top of the success ladder. Its
`meanT=0.200` average drags the bottom; the only above-zero scorer is MPAGE-04.

## Interpretation

The MPAGE batch confirms an existing hypothesis from the PRES results:
**`gemini-3.5-flash` understands the edit request semantically but does not
respect the "preserve everything else byte-identical" discipline.** Across
the batch, the model:

- Read paged-media CSS (with features it likely doesn't recognize) without
  issue.
- Located each edit anchor correctly.
- Produced a clean `apply_edits` envelope landing the requested change.
- Re-emitted surrounding paragraphs and CSS with paraphrased / reformatted
  variations — invisible to the success oracle, visible to the stability
  oracle.

The fix is not at the runtime level (the runtime is doing exactly what it's
told). The fix is in either:
1. **Prompt-level discipline** — stronger framing in the agent's system
   prompt about byte-identical preservation outside the edit window. The
   current system prompt covers this but the model is not internalizing it.
2. **Tool-level discipline** — the agent should be preferring narrowly-scoped
   `find`/`replace` pairs (MPAGE-04 shape) over paragraph-scope replacements
   that span multiple sentences (MPAGE-01..03, 05..10 shape).

## Retry rate

Measured by `benchmark/runners/measure-retries.mjs google/gemini-3.5-flash`.
Run truncated at PASTE-03 (78 of 98 model-driven scenarios completed before
the harness wall-clock cap; MPAGE batch fully covered).

### MPAGE retry headlines

**All 10 MPAGE scenarios: `meanRetries=0.00 anyRetry=0%`.** No malformed
envelopes, no `find_not_unique`, no `frozen_zone_violation` retries —
the model emitted a clean `apply_edits` envelope on the first attempt
every time, including against fixtures using CSS Paged Media features it
likely doesn't have strong training data for (`string-set`, `target-counter`,
`bookmark-level/label/state`).

### Suite-wide pattern (partial run, 82 scenarios)

| Metric | Value |
|---|---|
| Scenarios run | 82 (truncated at PASTE-03) |
| Scenarios with 0% retry | 65 |
| Scenarios with ≥1 retry | 1 (FAIL-09 only — intentional failure-mode test) |
| Custom-run / skipped | 16 (APP, DEG, INTERACT — bypass modify()) |

Only one scenario triggered any retries: **FAIL-09** with
`codes={find_not_unique, frozen_zone_violation}` — that scenario
explicitly tests the multi-failure recovery path and is *expected* to
retry.

### Comparison to `gemini-3.1-flash-lite-preview` (prior baseline)

The earlier measurement against `google/gemini-3.1-flash-lite-preview`
(`retries.google-gemini-3.1-flash-lite-preview.tsv`) showed:

- 19.5% of runs needed ≥1 retry (43/220)
- `malformed_envelope` dominant at 72 of 77 retry rounds
- `structural_irregular` tag worst at 75% retry rate
- `structural_regular` tag at 67%

**`gemini-3.5-flash` on the same suite is effectively retry-free outside
intentional failure-mode scenarios.** This is a step-change improvement in
tool-call discipline, not a marginal one. The `malformed_envelope` failure
mode that drove almost all retries on flash-lite has essentially disappeared
on the new flash model.

This finding has a substrate implication: the case for adding a "scout"
tool like `grep_doc` to help the model disambiguate anchors is now weaker
than the prior data suggested. The retry rate on the older model was the
empirical signal for that proposal (per `measure-retries.mjs`'s header
comment); against the current default model, the signal is gone. The
proposal stays valid for users on older / smaller models, but isn't load-
bearing for the default path.

## Coverage gaps (deferred)

Still uncovered after MPAGE-01..10:

- **Footnotes** — `@footnote { float: footnote; }` + `::footnote-call`
- **Floating figures** — `float: top` / `float: bottom`
- **Region chaining** — CSS Regions are deprecated in most engines
- **Print-specific link transforms** — `a[href]::after { content: " (" attr(href) ")"; }`
  is only partially covered by MPAGE-06 (target-counter variant)
- **Multi-row parallel tables** (the workflow v0.5+ shape)
- **Live page-break stress tests** — would need a real paged-media renderer
  (jsdom doesn't implement CSS Paged Media); we test the *invariant rules*,
  not where the actual page breaks land
