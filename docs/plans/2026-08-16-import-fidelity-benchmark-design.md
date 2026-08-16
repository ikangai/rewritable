# Import fidelity — a golden benchmark + regression ratchet

- **Date:** 2026-08-16
- **Author:** agent-18
- **Status:** design (validated with the operator; not yet implemented)
- **Area:** import fidelity measurement. Adds a **new** benchmark under `benchmark/` and a benchmark-only scorer; **reuses** `cli/src/import-fidelity.mjs` and does **not** modify the shipped converters (`cli/src/import.mjs`, `service/public/import.html`). No four-site mirror is triggered.

## The problem — "high fidelity" is asserted, never measured

The overall goal is a **standalone harness for documents** that imports existing files with **high fidelity**. Today that fidelity is a claim, not a number:

- The `benchmark/` harness measures the **edit** path (`rwa-edit/1` via `modify()`), not import. There is no `scenarios/import/`, no import runner, no `source → expected` corpus, and no CI import gate (confirmed: `benchmark/package.json` scripts are `conformance`/`fidelity*`/`calibrate`/`multimodel` only; `.github/workflows/ci.yml` gates `conformance` + `fidelity:stub`).
- The one deterministic import scorer, `structuralScore` in `cli/src/import-fidelity.mjs:41`, is `min(coverage, garble)` where `coverage` uses substring `includes` and `garble` counts only U+FFFD + control chars. Its own header is candid about the consequence: **reordered/duplicated text scores ~1.0**, and **wrong-encoding glyphs that aren't U+FFFD score ~1.0**. It reliably fires only on *dropped* text or replacement-char garble.

So the failures that most degrade a real import are invisible to the only number we have:

- **Reordered content** (the geometry PDF path merges/reorders runs — the motivating garbled-billing-row case in `docs/plans/2026-07-02-pdf-structural-reconstruction-design.md`).
- **Lost structure** — the default PDF import is positioned-`<span>` soup with zero `<table>`/`<h*>`/`<ul>`; DOCX loses footnotes/columns/merged cells.
- **Silently dropped special content** — `sanitizeImportedHtml` removes `<svg>` and `<math>` wholesale on MD + clone imports, so equations and diagrams vanish with only a generic warning (`cli/src/import.mjs` sanitizer).

**You cannot improve, or defend, what you cannot measure.** This step makes import fidelity a measured, regression-gated number — the prerequisite for every subsequent fidelity improvement (wiring the semantic PDF reconstructor, a DOCX style map, SVG/MathML allow-listing). It is the same "evaluator that sits outside the loop" discipline the repo already runs for the edit path.

## The key decision — golden *facts*, scored on multiple dimensions, ratcheted

Three decisions, each validated against how the repo already works.

### 1. Ground truth is a *fact manifest*, not golden HTML

For each source fixture we commit a sibling `<name>.expected.json` stating what a faithful import must contain — key phrases in order, headings, table shapes, list counts, whether an SVG/equation is present, an approximate word count.

Golden *HTML* was considered and rejected: PDF output is a large bag of absolutely-positioned spans and mammoth's DOCX output is verbose, so a golden-HTML diff would be enormous and would churn on every `pdfjs-dist`/`mammoth` version bump — brittle, high-noise, low-signal. A fact manifest is robust to library churn and asserts exactly the things that matter to a reader. (This is the same idea the 2026-07-02 reconstruction doc reached for — "golden real-invoice assertions on the structural model" — generalized across formats and actually built.)

### 2. Five scored dimensions, reusing the shipped scorer where it already works

Each dimension is `0..1`, scored per fixture from **facts extracted from the real converter output** vs the manifest:

| Dimension | Catches | Source |
|---|---|---|
| `coverage` | dropped text | **reuse** `structuralScore` coverage (`import-fidelity.mjs`) |
| `order` | **reordered content** — longest-common-subsequence of `keyPhrasesInOrder` against their positions in the output text ÷ expected count | **new** |
| `garble` | encoding/CMap garble | **reuse** `structuralScore` garble, broadened to also count Unicode private-use-area chars (a common CMap-failure signature) |
| `structure` | **lost tables / headings / lists** — closeness of found counts + table shape (rows×cols, within tolerance) to expected | **new** (jsdom fact extraction) |
| `special` | **silently dropped SVG / MathML** | **new** |

`order` is the dimension that repairs the documented blindness: a reordered paragraph keeps `coverage`≈1 but must drop `order`. `structure` and `special` turn today's silent semantic losses into visible measured numbers.

### 3. A ratchet at the current baseline, not an absolute bar

A committed `benchmark/baselines/import-fidelity.json` records **today's** per-fixture, per-dimension scores. `run-import.mjs --check` fails only if any dimension drops more than a small tolerance (0.02) below its baseline.

This matters: the default PDF path will legitimately score ~0 on `structure` today (span soup has no tables). A ratchet **locks that as a measured baseline** — "no worse than today" — instead of painting the benchmark red on day one for known current behavior. Later fidelity work (semantic PDF, DOCX style map) must *raise* the baseline, and the raise is provable and locked. Re-baselining is an explicit, reviewed commit — treated exactly like the repo's existing "gate change" rule (the same way a conformance/EDGE change is declared in its commit).

The CI gate stays **deterministic and model-free**, mirroring the repo's split: `fidelity:stub` is the gate, `fidelity-real` is scheduled. The opt-in VLM visual judge (`judgePage`/`parseJudge` in `service/public/import.html`) remains the manual/browser QA layer; it is not part of this gate.

## What is reused vs new

**Reuse (do not rebuild):**
- `cli/src/import-fidelity.mjs` — `structuralScore` coverage + garble become two of the five dimensions, imported, not reimplemented.
- The `benchmark/` scenario-discovery + `score.mjs` TSV/summary + `results/*.tsv` logging conventions — the import runner sits alongside `run-fidelity.mjs`, not a fresh harness.
- The real shipped converters in `cli/src/import.mjs` (`convertPdf`, `convertDocx`, `convertCsv`, `extractParagraphs`, the MD path, `sanitizeImportedHtml`) — the benchmark runs *these*, so it measures what users actually get.

**New:**
- The golden corpus + manifest schema.
- The benchmark-only multi-dimension scorer `benchmark/oracles/import-facts.mjs` (jsdom-based fact extraction; imports the CLI coverage/garble). Benchmark-only on purpose: **nothing new ships in the CLI, so the four-site converter mirror is not touched.**
- The runner, baseline, `--check` ratchet, and the CI job.

## The corpus (small, real, committed)

Real documents (never lorem), each tiny (< ~50 KB), under `benchmark/fixtures/import/`:

| Fixture | Format | Exercises |
|---|---|---|
| `pdf/memo.pdf` | PDF | coverage, order, garble on a plain multi-paragraph doc |
| `pdf/invoice.pdf` | PDF | `structure` (a table + right-aligned numerics) — documents the span-soup gap as a measured baseline the semantic reconstructor will later raise |
| `docx/report.docx` | DOCX | headings + lists + a table + bold/italic + an inline image (data-URI survival) |
| `csv/sales.csv` | CSV | table shape (rows×cols), header row |
| `md/guide.md` | Markdown | headings/lists/table/code **plus an inline `<svg>` and a math block** — pins the silent SVG/MathML drop as a measured `special`=0 today |
| `html/article.html` | saved HTML | offline `extractArticle` (clone extraction) with **no network** |

Each has a sibling `<name>.expected.json`:

```json
{
  "format": "pdf",
  "converter": "convertPdf",
  "keyPhrasesInOrder": ["Quarterly Memo", "Revenue rose 12%", "Next steps", "Conclusion"],
  "headings": [{ "level": 1, "text": "Quarterly Memo" }, { "level": 2, "text": "Next steps" }],
  "tables": [{ "rows": 5, "cols": 3 }],
  "lists": 2,
  "expectSvg": false,
  "expectMath": false,
  "approxWordCount": 240,
  "notes": "invoice table right-aligns the amount column"
}
```

A `benchmark/fixtures/import/README.md` documents the manifest schema and the "how to add a fixture" recipe so the corpus can grow without re-reading this doc.

## Increments (TDD, one commit each)

0. **This design doc.**
1. **Corpus + manifest schema.** Author the fixtures + `<name>.expected.json` for each + the fixtures README. *Verify:* every fixture loads and every manifest parses against the schema.
2. **Fact extractor + scorer** — `benchmark/oracles/import-facts.mjs` (jsdom fact extraction: h1–6 counts/levels, `<table>` rows×cols, `<ul>/<ol>`, `<svg>`, math; ordered-phrase LCS; garble broadened for PUA) reusing the CLI coverage/garble. *Test (Rule 9 — encodes the why):* a reordered-phrase HTML input must score low on `order` while `coverage`=1 (pins the exact blindness we are fixing); a table-stripped input must drop `structure`; an SVG-stripped input must drop `special`.
3. **Runner** — `benchmark/runners/run-import.mjs` runs the **real** CLI converters over the corpus, scores each fixture, emits TSV + JSON via the `score.mjs` conventions; add `npm run fidelity:import`. **⚠ Main technical risk, resolved here:** the runner must resolve the CLI's converter dependencies (`pdfjs-dist`, `mammoth`, `papaparse`, `marked`) from `benchmark/`. Approach: import the converters from `../cli/src/import.mjs` with the CLI's `node_modules` on the resolution path (a `file:../cli` dev dependency in `benchmark/package.json`, or a `NODE_PATH`/`--experimental` resolution in the runner — decided at implementation, whichever keeps CI's existing `npm ci` flow simplest). *Verify:* produces a score row for every fixture, and two consecutive runs are byte-identical (determinism is a precondition for a ratchet).
4. **Baseline + `--check` ratchet** — generate `benchmark/baselines/import-fidelity.json`; implement `--check` (fail if any dimension > 0.02 below baseline). *Verify:* unchanged code passes `--check`; a deliberately mangled converter output (e.g. force-drop the table) fails it with a legible per-dimension diff.
5. **CI wiring** — add `npm run fidelity:import -- --check` as a gate job in `.github/workflows/ci.yml` (its own job, or folded into the conformance job). *Verify:* green on `main`; red on an injected regression.

## Out of scope (so "done" means done)

- **Improving the converters** — wiring `cli/src/pdf-reconstruct.mjs` into an `--editable` PDF rung, a DOCX `styleMap`, safe SVG/MathML allow-listing. That is the **next** step; this benchmark is what makes it safe and provable. (When it lands, it *raises* the baseline.)
- **A cmp/parity gate between `cli/src/import.mjs` and `service/public/import.html` converters.** Valuable and a natural follow-on, but bigger. This step gates the **CLI** converters only; the browser mirror stays pinned by the existing parity unit tests (`import-fidelity-port.test.mjs`). This limitation is stated loudly, not hidden.
- **Automated visual/pixel fidelity in CI.** The VLM visual judge stays opt-in and manual; the deterministic gate is deliberately model-free.

## Risks

- **Converter dependencies in `benchmark/`** — the one real integration risk; owned by increment 3 and gated by the determinism check.
- **Library-version churn** — a `pdfjs-dist`/`mammoth` bump can shift scores. That is acceptable and expected: it surfaces as a `--check` failure, and re-baselining is the deliberate, reviewed response (a version bump *should* be a conscious event).
- **Fixture authorship** — fixtures must be real, tiny, and committed; a fixture that is too synthetic teaches the scorer nothing. The README's "how to add a fixture" recipe guards the corpus's honesty over time.

## Success criteria

- `npm run fidelity:import` scores every corpus fixture on all five dimensions, deterministically.
- `--check` passes on unchanged `main` and fails on an injected regression, with a per-dimension diff a human can read.
- CI gates it, model-free.
- The reordered-content / lost-table / dropped-SVG blindnesses of today's `structuralScore` are each pinned by a test that would fail if the scorer regressed to `min(coverage, garble)`.
