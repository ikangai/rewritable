# Import-fidelity corpus

Increment 1 of `docs/plans/2026-08-16-import-fidelity-benchmark-design.md`:
corpus + manifest schema only. **No scorer, no runner, no baseline, no CI
job lives here yet** — those are increments 2–5.

## Layout

```
benchmark/fixtures/import/
├── README.md                  (this file)
├── tools/gen-fixtures.mjs     dep-free generator for the BINARY fixtures
├── pdf/memo.pdf                pdf/memo.expected.json
├── pdf/invoice.pdf             pdf/invoice.expected.json
├── docx/report.docx            docx/report.expected.json
├── csv/sales.csv                csv/sales.expected.json
├── md/guide.md                   md/guide.expected.json
└── html/article.html             html/article.expected.json
```

Every fixture has a sibling `<name>.expected.json` — the **fact manifest**.
Two of the six source files (the PDFs, the DOCX) are binary and are produced
by `tools/gen-fixtures.mjs`; the other three (CSV, MD, HTML) are plain text
and are authored directly as files. Regenerate the binaries with:

```sh
node benchmark/fixtures/import/tools/gen-fixtures.mjs
```

## What the manifest means — READ THIS BEFORE ADDING A FIXTURE

**The manifest describes the ground truth of the SOURCE document** — what a
*faithful* import should contain — **not** what the current converter
happens to output today. `pdf/invoice.expected.json` is the clearest
example: the source really has a 5×3 table, so `tables:[{rows:5,cols:3}]`,
even though today's `convertPdf` emits absolutely-positioned spans with no
`<table>` element at all. That mismatch is the point — a later increment's
scorer diffs the real converter's output against this manifest, and a
`structure` score near 0 on that fixture is an accurate, *expected*
measurement of a real, documented gap (see
`docs/plans/2026-07-02-pdf-structural-reconstruction-design.md`), not a
fixture bug.

So the recipe for adding a fixture is: author the source document first,
decide what it *actually contains*, and record that — never back-fill the
manifest from a single run of the converter.

## Manifest schema

```json
{
  "format": "pdf|docx|csv|md|html",
  "converter": "convertPdf|convertDocx|convertCsv|convertMd|extractArticle",
  "keyPhrasesInOrder": ["phrase 1", "phrase 2", "..."],
  "headings": [{ "level": 1, "text": "..." }],
  "tables": [{ "rows": 5, "cols": 3 }],
  "lists": 2,
  "expectSvg": false,
  "expectMath": false,
  "approxWordCount": 240,
  "notes": "free text"
}
```

Field-by-field:

- **`format`** — the file extension class; matches the `ext` argument the
  CLI's `convert(ext, bytes)` (`cli/src/import.mjs`) dispatches on. `html`
  is the one exception — its manifest is scored against `extractArticle`
  (`cli/src/clone-extract.mjs`) directly, not the generic HTML importer,
  because the fixture's whole purpose is exercising chrome-stripping.
- **`converter`** — which internal function actually handles this format,
  for a human skimming the corpus. `convert()` is the real entry point the
  benchmark runner will call in increment 3; `convertPdf`/`convertDocx`/
  `convertCsv`/`convertMd` aren't separately exported from `import.mjs`
  today, so this field is documentation, not an import path.
- **`keyPhrasesInOrder`** — verbatim substrings expected to appear, **in
  this order**, in the converter's output text (HTML with tags stripped).
  Order matters: this is what a later `order` dimension scores (longest-
  common-subsequence of phrase positions) — the exact blindness
  `structuralScore`'s `coverage` (substring `includes`, order-blind) has
  today. Pick phrases short enough to survive verbatim (a converter can
  reflow whitespace); avoid phrases that straddle a manual PDF line break.
- **`headings`** — `{level, text}` pairs, describing the SOURCE document's
  real heading structure (h1 title, h2 sections, …), independent of whether
  today's converter for that format actually emits `<h*>` tags. A plain-PDF
  fixture may have zero rendered `<h1>` in `convertPdf`'s output today and
  still list `headings` in its manifest — see "what the manifest means"
  above.
- **`tables`** — `{rows, cols}` per table. **Convention (this corpus):**
  `rows` counts **every** row **including the header row**, matching the
  design doc's own worked example (`pdf/invoice.expected.json`: a 5-row
  table = 1 header + 4 data rows). `cols` is the total column count. Keep
  this convention consistent across all fixtures/formats in this corpus —
  don't switch to data-rows-only in a new fixture without updating this
  README and every existing manifest to match.
- **`lists`** — total count of list elements (`<ul>`/`<ol>` equivalents),
  not list *items*. A doc with one bulleted list and one numbered list is
  `lists: 2` regardless of how many `<li>`s each has.
- **`expectSvg` / `expectMath`** — whether the SOURCE genuinely contains an
  inline `<svg>` diagram / a `<math>` (MathML) block. Use raw `<math>…</math>`
  markup, not `$$…$$` LaTeX delimiters — `sanitizeImportedHtml`'s
  `_ACTIVE_TAGS` strip actual `<math>`/`<svg>` tags; bare `$$…$$` text isn't
  recognized as math by `marked` (no LaTeX plugin) and would just pass
  through as plain text, silently defeating the fixture's purpose.
- **`approxWordCount`** — a rough prose word count of the *visible* source
  content (excluding markup/table-pipe syntax). "Approx" — this is a
  sanity range for a future coverage check, not an exact assertion.
- **`notes`** — free text: what the fixture is *for*, and anything a scorer
  author needs to know that isn't captured by the structured fields above.

## Verifying a fixture

There is no committed verification script in this corpus (Rule 2 — nothing
speculative gets checked in ahead of the increment that needs it). To
sanity-check a fixture by hand, run it through the real converter from a
`node` REPL or scratch script with `cli/`'s `node_modules` resolvable (e.g.
run from inside `cli/`, or import `cli/src/import.mjs` — bare-specifier
resolution walks up from the importing file's own path, so this works from
any cwd as long as `cli/node_modules` exists):

```js
import { convert } from '.../cli/src/import.mjs';
import { readFileSync } from 'node:fs';
const { html, warnings } = await convert('pdf', readFileSync('pdf/memo.pdf'));
```

Confirm it doesn't throw, returns non-empty HTML, and that every
`keyPhrasesInOrder` entry is a substring of the tag-stripped output text, in
order (search for phrase *N* starting just after phrase *N-1*'s match — that
proves order, not just presence).

## Known deviation: the DOCX inline image

`docx/report.docx` includes a genuine tiny (68-byte, 1×1 pixel) inline PNG:
real `wp:inline`/`a:graphic`/`pic:pic`/`a:blip` drawing markup in
`word/document.xml`, the image bytes at `word/media/image1.png`, and the
`r:embed` relationship in `word/_rels/document.xml.rels`. This was verified
against `mammoth`'s actual read path (`readDrawingElement`/`readBlip` in
`mammoth/lib/docx/body-reader.js`), not assumed — **it made it in**: mammoth
emits a `data:image/png;base64,...` `<img src>` for it (mammoth's default
image conversion is `images.dataUri`). So `docx/report.expected.json`
implicitly documents a working image path; there is no `image` field in the
schema because this is the only fixture that carries one and it round-trips
cleanly — a future increment scoring image survival can grep the converter
output for `<img src="data:image/png`.

## How to add a fixture

1. Pick real, small (< 50 KB), non-lorem-ipsum content that exercises a
   specific gap (a table, a list, an SVG, reordered text, …).
2. Author the source file. Binary formats (PDF/DOCX/etc.) go through
   `tools/gen-fixtures.mjs` so the corpus stays reproducible and
   dependency-free — do not hand-craft binary fixtures with an external
   tool (Word, a PDF exporter, …) and commit the opaque output; add a
   generator function instead. Determinism is load-bearing: two runs of the
   generator must byte-for-byte match (`sha256sum` twice) — no
   `Date.now()`, no `Math.random()`, no environment-derived bytes anywhere
   in the generator.
3. Write the `<name>.expected.json` manifest from the SOURCE's real
   content — never from a single run of the converter (see "what the
   manifest means" above).
4. Sanity-check per "Verifying a fixture" above.
5. If the fixture is meant to pin a KNOWN converter gap (like the invoice's
   missing `<table>`), say so explicitly in `notes` — that's what makes the
   corpus honest instead of just decorative.
