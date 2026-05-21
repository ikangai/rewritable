# Print-fidelity scenarios

Self-contained HTML fixtures that exercise the runtime's print stylesheet
across the failure modes that matter for "save as PDF" output.

## Quick start

```bash
# Regenerate the .html fixtures from generate.mjs
node benchmark/scenarios/print/generate.mjs

# Open any scenario in a browser; preview with Cmd/Ctrl-P
open benchmark/scenarios/print/sp-02-short-prose.html

# Run automated assertions (requires Chrome + poppler-utils)
node benchmark/scenarios/print/validate.mjs
```

The validator prints each fixture to PDF via headless Chrome, then runs
text-only assertions on the result: page count, text presence/absence,
"every row on exactly one page", "caption + table on same page", and
forced-break-target-page. Expected output: `23 passed, 0 failed`.

## Side-by-side: source HTML ↔ rendered PDF

The validator writes one PDF per fixture, same basename, to
`benchmark/results/print/` (gitignored). After a run:

```
benchmark/scenarios/print/<id>.html   ← source fixture
benchmark/results/print/<id>.pdf      ← what Chrome printed
```

Open both side-by-side to eyeball the rendering, or compare PDFs across
runs after a print-CSS change:

```bash
# Compare two runs (e.g. before / after a seed CSS edit)
mv benchmark/results/print benchmark/results/print.before
node benchmark/scenarios/print/validate.mjs
diff -r benchmark/results/print.before benchmark/results/print
```

## Verification protocol

Each fixture embeds the seed's print CSS verbatim (mirrored in
`generate.mjs`'s `PRINT_CSS` constant). The verification protocol:

1. Open the fixture in **Chromium** (Chrome / Edge / Brave). Chromium is
   the primary save-as-PDF target — Safari and Firefox behave slightly
   differently for some scenarios (notably named-page margin-boxes).
2. Hit **⌘P / Ctrl-P** to enter print preview.
3. In the print dialog: paper size A4 (or Letter), background graphics
   **enabled**, margins **default** (do NOT override — that's what `@page`
   controls in the document).
4. Walk through the **checklist** embedded as an HTML comment at the top
   of the fixture (also reproduced below).
5. If any checklist item fails, the scenario fails.

For automated text-level checks, run `node validate.mjs` from this
directory — it prints each fixture to PDF with headless Chrome and
asserts the per-scenario text invariants. See `_runner-spec.md` for
the larger puppeteer-based design that adds pixel-level checks.

## Scenario index

| Fixture | Category | What it tests |
| --- | --- | --- |
| `sp-01-placeholder-only.html` | Single-page | placeholder-only doc prints as a blank single page |
| `sp-02-short-prose.html` | Single-page | short prose fits one page and expands to full width |
| `sp-03-receipt.html` | Single-page | receipt-style doc fits one page with table intact |
| `mp-01-long-prose.html` | Multipage prose | long prose paginates naturally with no orphan/widow lines |
| `mp-02-heading-near-break.html` | Multipage prose | H2 near a page break moves with its following paragraph |
| `tbl-01-small-intact.html` | Tables | small table fits on one page intact |
| `tbl-02-long-breaks-between-rows.html` | Tables | 25-row table breaks BETWEEN rows, never mid-row |
| `tbl-03-tall-row-moves.html` | Tables | a row with tall content moves to next page as a unit |
| `tbl-04-wide-no-overflow.html` | Tables | wide 9-column table fits within the printable width |
| `tbl-05-caption-with-table.html` | Tables | table caption stays with its table |
| `code-01-short-pre-intact.html` | Code blocks | short <pre> stays intact on one page |
| `code-02-long-pre-must-break.html` | Code blocks | <pre> longer than a page is forced to break (known limit) |
| `list-01-long-list-breaks-between-items.html` | Lists | 30-item list breaks between items, never mid-item |
| `list-02-multiline-items-intact.html` | Lists | list items with multi-line content stay intact |
| `fig-01-figure-caption-together.html` | Figures | figure and its caption stay together |
| `fig-02-figure-near-boundary-moves.html` | Figures | figure near page boundary moves to the next page |
| `chr-01-runtime-chrome-hidden.html` | Runtime chrome | #rwa-runtime, lens, and .placeholder are all hidden in print |
| `pg-01-default-18mm-margin.html` | @page rules | default @page margin is 18mm on all sides |
| `pg-02-document-override-wins.html` | @page rules | document-level @page override beats the runtime default |
| `pg-03-named-pages-cover-and-body.html` | @page rules | named pages: cover (no margins, no header) + body (header + page number) |
| `edge-01-forced-break-before.html` | Edge cases | forced break-before:page starts a new section on a new page |
| `edge-02-colored-bg-and-links.html` | Edge cases | colored backgrounds preserved (print-color-adjust:exact); links forced black |
| `edge-03-oversize-block-breaks-inside.html` | Edge cases | block taller than a page is forced to break inside (known limit) |

## Per-scenario detail

### `sp-01-placeholder-only.html` — Single-page

**Title.** placeholder-only doc prints as a blank single page

**Hypothesis under test.** .placeholder { display: none } in @media print removes the invitation copy so an unwritten doc prints clean — heading only, no lorem-esque "Start writing…" text.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows EXACTLY ONE page.
   2. The page shows only the H1 "Untitled" at the top.
   3. The placeholder paragraph "Start writing, or ask…" does NOT appear anywhere.

---

### `sp-02-short-prose.html` — Single-page

**Title.** short prose fits one page and expands to full width

**Hypothesis under test.** On screen the article is capped at 720px (centred); on print the @media print override removes max-width so the prose uses the full page width (A4 minus 2×18mm = ~174mm).

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows EXACTLY ONE page.
   2. The paragraph text spans the full printable width — measure with a ruler/eyeball: roughly 17cm of usable width, not the 720px (≈19cm at default DPI) on-screen card.
   3. There is no left or right gutter wider than the 18mm page margin.

---

### `sp-03-receipt.html` — Single-page

**Title.** receipt-style doc fits one page with table intact

**Hypothesis under test.** A short doc with a key/value header plus a small itemised table fits one page with the table never split.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows EXACTLY ONE page.
   2. The line-items table is rendered as a single intact block — no row appears at the top of a phantom page 2.
   3. The "Total" row sits directly under the last line item, never on its own page.

---

### `mp-01-long-prose.html` — Multipage prose

**Title.** long prose paginates naturally with no orphan/widow lines

**Hypothesis under test.** orphans:3 / widows:3 on <p> prevent a single line of a paragraph being stranded at the top or bottom of a page.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 3 pages.
   2. On every page boundary: the bottom of one page does not show a single line of a paragraph followed by the rest on the next page (no widow of 1–2 lines).
   3. No page starts with a single trailing line of the previous page's paragraph (no orphan of 1–2 lines).
   4. Page transitions happen between paragraphs whenever possible.

---

### `mp-02-heading-near-break.html` — Multipage prose

**Title.** H2 near a page break moves with its following paragraph

**Hypothesis under test.** break-after:avoid + page-break-after:avoid on h1-h6 prevents a heading being stranded at the bottom of a page while the body content starts on the next.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 2 pages.
   2. Scan every page boundary: NO H2 appears as the LAST element on a page.
   3. Every visible H2 is immediately followed by at least one of its paragraphs on the same page.

---

### `tbl-01-small-intact.html` — Tables

**Title.** small table fits on one page intact

**Hypothesis under test.** break-inside:avoid on <table> keeps a small table from being split unnecessarily.

**Manual checklist (Chromium ⌘P preview):**
   1. The 6-row table appears as ONE intact block (header + 6 rows) on a single page.
   2. No row of the table appears on a different page from the header.

---

### `tbl-02-long-breaks-between-rows.html` — Tables

**Title.** 25-row table breaks BETWEEN rows, never mid-row

**Hypothesis under test.** When a table is larger than a single page, the engine breaks it across pages but break-inside:avoid on <tr> ensures the split lands at a row boundary, not inside a row.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 2 pages.
   2. On the boundary between page 1 and page 2: scan the bottom of page 1 and the top of page 2 — the same row must NOT appear partially on both.
   3. Every row is fully visible on exactly ONE page.

---

### `tbl-03-tall-row-moves.html` — Tables

**Title.** a row with tall content moves to next page as a unit

**Hypothesis under test.** A row with several paragraphs in one cell — much taller than other rows — must move to the next page as a whole when it would otherwise straddle the boundary.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 2 pages.
   2. The "tall" row (the third row, containing multi-paragraph notes) appears entirely on one page.
   3. There is NO scenario where the first paragraph of the tall row sits on page 1 while the second paragraph sits on page 2.

---

### `tbl-04-wide-no-overflow.html` — Tables

**Title.** wide 9-column table fits within the printable width

**Hypothesis under test.** A table with width:100% on screen should reflow to the print page width, not overflow the right margin (no clipped rightmost columns).

**Manual checklist (Chromium ⌘P preview):**
   1. All 9 columns are visible on every page where the table appears.
   2. The right edge of the table aligns to the right margin of the page; columns are not clipped.
   3. If columns are too narrow to read, that is acceptable — the test is that nothing is HIDDEN.

---

### `tbl-05-caption-with-table.html` — Tables

**Title.** table caption stays with its table

**Hypothesis under test.** A <caption> inside a <table> is part of the same block that break-inside:avoid protects — caption and at least the header row stay together.

**Manual checklist (Chromium ⌘P preview):**
   1. The caption "Table 1: ..." appears on the same page as the table header row.
   2. There is NO page where the caption appears at the bottom and the table header appears at the top of the next page.

---

### `code-01-short-pre-intact.html` — Code blocks

**Title.** short <pre> stays intact on one page

**Hypothesis under test.** break-inside:avoid on <pre> keeps a short code block from being split across pages.

**Manual checklist (Chromium ⌘P preview):**
   1. The 10-line code block appears as ONE intact block on a single page.
   2. No line of the code appears on a different page from the rest.

---

### `code-02-long-pre-must-break.html` — Code blocks

**Title.** <pre> longer than a page is forced to break (known limit)

**Hypothesis under test.** When a single <pre> exceeds one printed page, the rendering engine is forced to break inside it (break-inside:avoid is a HINT, not a guarantee). This scenario DOCUMENTS the limit rather than fixing it: the user must split long code blocks manually if intact printing matters.

**Manual checklist (Chromium ⌘P preview):**
   1. The code block spans at least 2 pages.
   2. The break lands at a LINE boundary, not mid-character or mid-word.
   3. No code line is split in half horizontally between two pages.
   4. NOTE: This scenario PASSES if the break is line-aligned, even though the pre was split.

---

### `list-01-long-list-breaks-between-items.html` — Lists

**Title.** 30-item list breaks between items, never mid-item

**Hypothesis under test.** break-inside:avoid on <li> keeps each list item intact across page boundaries.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 2 pages.
   2. No list item is split between two pages — each bullet sits on exactly ONE page.

---

### `list-02-multiline-items-intact.html` — Lists

**Title.** list items with multi-line content stay intact

**Hypothesis under test.** A list item containing several lines of text (or wrapped long text) is kept on one page by break-inside:avoid on <li>.

**Manual checklist (Chromium ⌘P preview):**
   1. Every list item with a long description is fully visible on ONE page.
   2. No item's description starts on one page and continues on the next.

---

### `fig-01-figure-caption-together.html` — Figures

**Title.** figure and its caption stay together

**Hypothesis under test.** break-inside:avoid on <figure> keeps the image and its <figcaption> on the same page.

**Manual checklist (Chromium ⌘P preview):**
   1. The image AND its caption appear on the SAME page.
   2. There is no page where the image appears at the bottom and the caption at the top of the next page.

---

### `fig-02-figure-near-boundary-moves.html` — Figures

**Title.** figure near page boundary moves to the next page

**Hypothesis under test.** A figure that would otherwise be cut in half by a page break is moved entirely to the next page.

**Manual checklist (Chromium ⌘P preview):**
   1. The figure (the second SVG) appears entirely on ONE page.
   2. No part of the figure or its caption is split across pages.
   3. It is acceptable for the bottom of the preceding page to have whitespace where the figure was moved away from.

---

### `chr-01-runtime-chrome-hidden.html` — Runtime chrome

**Title.** #rwa-runtime, lens, and .placeholder are all hidden in print

**Hypothesis under test.** The print stylesheet hides #rwa-runtime entirely, and .placeholder { display: none } removes the invitation copy. Neither should leak into print output.

**Manual checklist (Chromium ⌘P preview):**
   1. The bottom-of-page "lens placeholder" floating card does NOT appear in print preview.
   2. The .placeholder paragraph "Start writing…" does NOT appear in print preview.
   3. On screen (before printing), the lens IS visible at the bottom of the viewport.

---

### `pg-01-default-18mm-margin.html` — @page rules

**Title.** default @page margin is 18mm on all sides

**Hypothesis under test.** @page { margin: 18mm } gives a uniform 18mm margin on A4/Letter so the prose fits inside a predictable safe area.

**Manual checklist (Chromium ⌘P preview):**
   1. In print preview, the top edge of the first line of text sits ~18mm from the top of the page.
   2. Left and right edges of body text are ~18mm from the page edges.
   3. Bottom of the last line is ~18mm above the bottom edge.
   4. Use a ruler tool or the print-preview measurements panel for verification.

---

### `pg-02-document-override-wins.html` — @page rules

**Title.** document-level @page override beats the runtime default

**Hypothesis under test.** A document's own @page rule (declared after the runtime's) overrides margin / size — because both rules cascade and the document's comes later.

**Manual checklist (Chromium ⌘P preview):**
   1. The page margins are notably tighter (~6mm on all sides), NOT the default 18mm.
   2. This proves the document's @page rule won over the runtime's @page { margin: 18mm } default.

---

### `pg-03-named-pages-cover-and-body.html` — @page rules

**Title.** named pages: cover (no margins, no header) + body (header + page number)

**Hypothesis under test.** @page :first (or a named-page selector) can carry margin-boxes for headers/footers/page numbers; the cover page is rendered with margin:0 and no margin-box content.

**Manual checklist (Chromium ⌘P preview):**
   1. Page 1 (the cover) prints edge-to-edge with NO header and NO page number.
   2. Page 2 onward prints with a top-center header reading "Annual Report 2026" and a bottom-center page number.
   3. Page numbers increment correctly (1, 2, 3…) on body pages. NOTE: page-number rendering depends on browser engine — Chromium supports counter(page) only via margin-boxes; Safari may differ. Document the actual behavior observed.

---

### `edge-01-forced-break-before.html` — Edge cases

**Title.** forced break-before:page starts a new section on a new page

**Hypothesis under test.** A section with break-before:page (or page-break-before:always) starts a new printed page even if the previous page has room.

**Manual checklist (Chromium ⌘P preview):**
   1. Print preview shows AT LEAST 3 pages.
   2. The H1 "Chapter 2" begins at the TOP of a new page (page 2), regardless of how much space remained on page 1.
   3. The H1 "Chapter 3" begins at the TOP of yet another new page.

---

### `edge-02-colored-bg-and-links.html` — Edge cases

**Title.** colored backgrounds preserved (print-color-adjust:exact); links forced black

**Hypothesis under test.** -webkit-print-color-adjust:exact + print-color-adjust:exact preserve colored backgrounds (callout boxes, highlights). a { color:#000 } in @media print converts blue link text to black so it remains legible when printed monochrome.

**Manual checklist (Chromium ⌘P preview):**
   1. The yellow callout box prints with its yellow background visible.
   2. The green "ok" badge prints with its green background visible.
   3. Hyperlink text (the "rewritable docs" link) prints in BLACK, not blue.
   4. If colored backgrounds are missing, the user may have disabled "Background graphics" in print options — verify it is enabled.

---

### `edge-03-oversize-block-breaks-inside.html` — Edge cases

**Title.** block taller than a page is forced to break inside (known limit)

**Hypothesis under test.** break-inside:avoid is a hint. When a single <blockquote> is taller than a page, the engine MUST break inside it. The expected behavior is a clean break between lines, not mid-character.

**Manual checklist (Chromium ⌘P preview):**
   1. The blockquote spans AT LEAST 2 pages.
   2. The break inside the blockquote lands at a clean LINE boundary.
   3. No line of the blockquote is split horizontally across two pages.
   4. NOTE: this scenario documents a limit, not a bug — there is nothing CSS can do to keep an oversize block on one page.


## What the print CSS protects

The fixtures cover each claim the runtime's `@media print` block makes:

| Claim | Scenarios |
| --- | --- |
| 18mm @page margin | `pg-01`, `pg-02` |
| Document @page wins over runtime default | `pg-02`, `pg-03` |
| Named pages (first / body) + margin-boxes | `pg-03` |
| Runtime chrome (`#rwa-runtime`) hidden | `chr-01` |
| `.placeholder` hidden | `sp-01`, `chr-01` |
| `article { max-width: none }` on print | `sp-02` |
| `break-after: avoid` on h1-h6 | `mp-02` |
| `break-inside: avoid` on table | `tbl-01`, `tbl-05` |
| `break-inside: avoid` on tr | `tbl-02`, `tbl-03` |
| `break-inside: avoid` on pre | `code-01` (and `code-02` documents the limit) |
| `break-inside: avoid` on li | `list-01`, `list-02` |
| `break-inside: avoid` on figure | `fig-01`, `fig-02` |
| `break-inside: avoid` on blockquote | (limit documented in `edge-03`) |
| `orphans: 3; widows: 3` on p | `mp-01` |
| `a { color: #000 }` on print | `edge-02` |
| `print-color-adjust: exact` | `edge-02` |
| Forced `break-before: page` | `edge-01` |

## How to add a scenario

1. Add an entry to the `SCENARIOS` array in `generate.mjs`. Required
   fields: `id`, `category`, `title`, `hypothesis`, `checklist`, `body`.
   Optional: `extraStyle`, `includeRuntimeChrome`.
2. Pick an `id` of the form `<category>-NN-shortname`.
3. Re-run `node generate.mjs`. The new `.html` file appears alongside
   the others, and MANIFEST.md is regenerated.
4. Walk the checklist yourself in Chromium print preview at least once
   to make sure the scenario behaves as described — both the
   "passes-on-current-runtime" and "would-fail-if-the-runtime-broke-X"
   sides.

## Known scope limits

- These fixtures assume Chromium semantics. Firefox's print engine
  honors break-* hints slightly differently; Safari ignores some
  margin-box content. The fixtures still print correctly there, but the
  named-page header/footer in `pg-03` is the most engine-sensitive.
- jsdom (the conformance harness) cannot evaluate page-break rules. The
  print fixtures are therefore NOT run as part of `npm run conformance`
  or `npm run fidelity`. See `_runner-spec.md` for the optional headless
  runner that wraps these fixtures in puppeteer.
- iOS Safari's "Save to PDF" share path uses the same WebKit engine as
  desktop Safari for layout, but adds its own page-break heuristics on
  top — verify there separately for critical share targets.
