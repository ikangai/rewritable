# Optional headless-Chrome runner — design sketch

The 23 print fixtures in this directory are **manually verifiable today**:
open the `.html` in Chromium, hit `⌘P`, walk the embedded checklist.

This file is the design for an *optional* automated runner that drives the
same fixtures via headless Chrome, generates PDFs, and asserts per-scenario
invariants. It is intentionally not built yet — sketched here so the
scenario authors don't need to "write the runner first" to land coverage.

## Why not built yet

- Adds a 50–100MB dependency (puppeteer pulls Chromium, or use
  `puppeteer-core` + system Chrome).
- `benchmark/package.json` is currently jsdom-only; the team has been
  intentional about minimal deps (see `CLAUDE.md` — "No React, no npm
  beyond what we need").
- Manual print preview catches regressions in human time when the print
  CSS changes. The CSS rarely changes; the cost/benefit doesn't (yet)
  justify auto-running 23 PDF generations on every CI build.

Land it when one of those costs flips: print CSS becomes a frequent
target, or a regression slips through manual review.

## Architecture (when built)

```
benchmark/runners/run-print.mjs
  ├── for each fixture in benchmark/scenarios/print/*.html
  │     ├── headless Chrome → page.goto('file://…') → page.pdf({ format:'A4' })
  │     ├── parse the PDF (pdf-parse or pdf2json)
  │     └── run per-scenario assertions on the parsed output
  └── aggregate: scenario_id → { pass: bool, reason: string }
```

### Per-scenario assertion glue

Each fixture in this directory already carries its acceptance criteria
in the HTML comment header. The runner needs a **machine-readable**
version of those criteria. Two options:

**Option A — JSON sidecar.** Bump `generate.mjs` to emit
`<id>.assertions.json` alongside each `.html`:

```json
{
  "id": "tbl-02-long-breaks-between-rows",
  "min_pages": 2,
  "no_text_clipped": true,
  "every_row_present": ["ACCT-0001", "ACCT-0002", "…", "ACCT-0025"],
  "every_string_on_one_page": ["ACCT-0001", "…", "ACCT-0025"]
}
```

**Option B — inline JSON-LD inside each fixture.** The fixture's `<head>`
carries a `<script type="application/json" id="print-assertions">` block.
Self-contained — the fixture knows its own pass condition.

Recommendation: **Option B**. Keeps each fixture standalone; the runner
just reads the script block. Sidecars create drift risk.

### Assertion primitives needed

The 23 scenarios reduce to a small vocabulary of assertions:

| Primitive | Used by |
| --- | --- |
| `pages == N` | `sp-*`, `tbl-01`, `code-01`, `fig-01`, `chr-01` |
| `pages >= N` | `mp-*`, `tbl-02`, `code-02`, `list-*`, `edge-*` |
| `string_absent_in_pdf(s)` | `sp-01`, `chr-01` (no "Start writing", no lens) |
| `string_present_in_pdf(s)` | most scenarios |
| `string_on_exactly_one_page(s)` | `tbl-02`, `tbl-03`, `list-01`, `list-02` |
| `strings_on_same_page(a, b)` | `tbl-05` (caption + table), `fig-*` (image + caption), `chr-01` (lens hidden everywhere) |
| `string_starts_page(s, n)` | `edge-01` (Chapter 2 starts page 2) |
| `pdf_has_color_on_page(n)` | `edge-02` (background graphics present) |
| `pdf_text_color(s) == "#000"` | `edge-02` (link text black) |

The first six cover ~80% of the scenarios and require only a text-extract
PDF parser (`pdf-parse`). The last three need a pixel-level inspector
(rasterize page → sample pixels) — defer until needed.

### Dependency footprint

Minimum (text-only assertions):
- `puppeteer-core` (no bundled Chromium; use system Chrome via
  `CHROME_PATH` env, mirroring how `cli/` already calls out to local
  Chrome for some flows)
- `pdf-parse` (~3MB, no native deps)

Adds: ~5MB on disk, two npm deps. Acceptable if the value lands.

For pixel assertions (later):
- `pdf-poppler` (binds to system poppler — rasterize page → PNG)
- `pngjs` to read pixel data

### CI / local workflow

```bash
npm run print:headed      # opens each fixture in a real browser window
npm run print:headless    # generates PDFs in benchmark/results/print/
npm run print:assert      # runs per-fixture assertions, reports pass/fail
npm run print              # all three in sequence
```

The PDFs land in `benchmark/results/print/<scenario-id>.pdf` so a human
can flip through them when an assertion fails.

### Why not use chrome-devtools-mcp instead?

`chrome-devtools-mcp` is an interactive tool — great for ad-hoc
inspection from inside a Claude Code session, not great for CI. The
runner needs to be:
- Reproducible (same fixture → same PDF bytes is ideal)
- Headless (no UI required)
- Scriptable from `package.json`

That's where `puppeteer-core` fits cleanly. `chrome-devtools-mcp` would
need an MCP server running during the test run — too much overhead per
CI invocation.

For an interactive session ("I just changed the print CSS, did anything
regress?"), `chrome-devtools-mcp` is the right tool — drive it to each
fixture, eyeball the preview. See `MANIFEST.md` for the manual protocol.

## What this runner is NOT

- **Not** a substitute for the manual checklist. Page-break "quality"
  is partly subjective — a runner can confirm a table didn't split
  mid-row, but it can't tell you the resulting pagination looks good to
  a human reader. Keep the manual protocol.
- **Not** a full print-rendering test. It tests Chromium's output. Safari
  / Firefox / iOS WebKit need their own pass — same fixtures, different
  viewer. Probably manual forever.
- **Not** a screenshot-diff regression detector. Pixel diffs on rendered
  PDFs are flaky (font subpixel rendering, color profile, paper-size
  rounding). Stick to semantic assertions.

## Tracking

When this runner lands, link this file from `benchmark/README.md` under
a new "Print fidelity" section, and add `print` next to the existing
`conformance` / `fidelity` / `fidelity:dsl` modes.
