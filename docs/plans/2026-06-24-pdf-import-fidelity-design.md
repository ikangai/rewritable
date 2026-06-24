# PDF import fidelity — geometry-faithful reconstruction (2026-06-24)

## Problem

`rwa import <file>.pdf` (and the browser `/import`) produced output that looked
nothing like the source PDF. A scanned invoice came back as a flat stack of
`<p>` paragraphs — every column, table, alignment, and rule was gone.

## Root cause

`convertPdf` in `cli/src/import.mjs` (mirrored in `service/public/import.html`)
was a **prose extractor**: it ran pdf.js `getTextContent()`, grouped items into
reading-order lines via `extractParagraphs`, and emitted `<p>` blocks. It threw
away all geometry by design (its own warning said "layout reconstructed by
heuristics"). Not a bug — a design limitation.

## Decision

Chosen approach (user picked this over a pixel-perfect page image and over a
semantic-table reconstruction): **editable reconstruction** — reproduce the page
with real, positioned text plus drawn vector rules, no raster. Keeps the
rewritable genuinely editable (the ⌘K agent rewrites the span text via
find/replace) while looking like the PDF. Works identically in CLI and browser
with no new dependency and no canvas.

## How it works (`renderPdfPage` + helpers)

Per page, build an absolutely-positioned layer at the PDF's real point size:

- **Text → positioned runs.** Each text item is placed in device space via
  `Util.transform(viewport.transform, item.transform)` (font height from the
  matrix, box top at `baseline − ascent`). Items are then grouped into **runs** —
  adjacent, same-style glyphs on one baseline — and each run is one `<span>` that
  flows naturally. Splitting only at a real column gap (`> ~1.2× font size`), a
  style change, or a new line.
  - **Why runs, not per-item spans:** the embedded font isn't shipped, so a wider
    substitute (Georgia for Cambria) overflows each item's slot and collides with
    the next, eating inter-word spaces (`DPBGmbH`, `MichaelMaier`). A flowing run
    spaces words with the substitute's own metrics while staying pinned at the
    run's true start x, so columns and table cells stay put. Side benefit: ~42
    meaningful runs instead of ~150 glyph fragments — cleaner DOM, better edits.
  - **Weight/style** recovered from the embedded font's real PostScript name via
    `page.commonObjs.get(fontName).name` (`Cambria-Bold` → `font-weight:700`,
    `-Italic` → `font-style:italic`); the sanitized `fontName` carries none.
- **Graphics → positioned divs.** Walk the operator list with a CTM stack
  (`save`/`restore`/`transform`) tracking fill/stroke color. pdfjs 5.x fuses the
  paint op into `constructPath` (leading opcode), so every `fill`/`stroke` path's
  device-space bbox (`args[2]` minMax mapped through the CTM) becomes a `<div>`.
  This invoice draws all rules/boxes as thin filled rectangles, so bbox-only
  rendering is exact; curves degrade to their bounding box. White (`#ffffff`)
  knockouts are skipped (invisible on the white page).
- A scoped `<style>` (gray viewer backdrop, white pages, print rules) ships once
  in the `<article class="rwa-pdf">`. The scanned-PDF guard (`totalText === 0`)
  is preserved.

## Accepted limitations ("near-perfect", not pixel-exact)

- Substitute system fonts, not the embedded faces (no font embedding → no file
  bloat). Run-relative horizontal positions are approximate; run starts are exact.
- Text color defaults to black (`getTextContent` carries no per-glyph color); the
  blue email **underline** is captured from its fill path, but its text stays
  black.
- Rotated text is handled per-item (not run-merged); rare in documents.

## Sites & verification

- Two sites, kept aligned: `cli/src/import.mjs` and `service/public/import.html`
  (byte-identical reconstruction logic; only the pdfjs handle + error style
  differ). Verified by running the browser helpers in Node against a real
  invoice — output **diff-identical** to the CLI.
- Real-browser screenshot of the imported invoice matches the PDF (header rule,
  right-aligned sender block, italic table headers, full table grid + boxed
  `Summe`, 3-column footer with blue email).
- CLI suite green (488/488). No seed change.
