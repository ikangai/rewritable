# docx + pdf import — design

Date: 2026-05-08
Status: design, not yet implemented

## Motivation

The author wants to migrate an existing corpus of `.docx` and text-native `.pdf`
documents into rewritables. The current import pipeline (`rwa import` and the
service's `/import` page) handles `.md`, `.html`, `.csv`, `.txt`. Without docx
and pdf the migration path is "open in Word, save as html, then import" — enough
friction to block adoption for the author's own use case.

The two formats together cover the realistic source mix (Google Docs and Word
exports for docx; self-produced text-native PDFs for pdf). OCR'd / scanned PDFs,
old `.doc` binary, and `.rtf` are explicitly out of scope.

## Goal and non-goals

**Goal:** `rwa import foo.docx` and `rwa import foo.pdf` produce a self-contained
rewritable `.html`, byte-equivalent to what the service's `/import` drag-drop
produces for the same input. Best-effort structured HTML on arrival; the author
runs `⌘K` to refine afterward.

**Non-goals:**
- OCR for scanned PDFs.
- `.doc` (pre-2007 binary) and `.rtf`.
- Footnote / endnote / bibliography reconstruction.
- Multi-column PDF detection or table extraction from PDF.
- Heading detection in PDFs from font-size heuristics (too flaky; rely on `⌘K`).
- An auto-fired post-import agent cleanup pass.

## Fidelity contract

| Format | What we preserve                                       | What we drop                                                  |
|--------|--------------------------------------------------------|---------------------------------------------------------------|
| docx   | Headings, paragraphs, lists, tables, bold/italic,      | Comments, tracked changes, fields, complex SmartArt,          |
|        | hyperlinks, embedded images (as `data:` URLs)          | unmapped custom styles (surfaced as warnings)                 |
| pdf    | Paragraphs (heuristic), reading order within a page    | Headings, lists, tables, columns, footnotes, images, fonts    |

For both, the imported document lands as a single `<article>` inside `INLINE_DOC`
exactly as today's `.md` / `.html` paths do.

## Architecture

Two surfaces, mirrored. Three sites today must stay aligned (`cli/src/import.mjs`,
`service/public/import.html`, `seeds/rewritable.html` for the splice). After this
change, four sites: the two converters live in both CLI and service.

### CLI (`cli/`)

Dependencies added to `cli/package.json`:
- `mammoth` (~300 KB unpacked) — docx → HTML, pure JS, no native bindings.
- `pdfjs-dist` (~1 MB unpacked) — text extraction, pure JS, Node 18+ ESM.

`cli/src/import.mjs`:
- Promote `convert(ext, content)` from text-only to `convert(ext, bytes)` where
  `bytes` is a `Buffer` / `Uint8Array`. Text formats decode via `bytes.toString('utf8')`
  internally; binary formats consume bytes directly.
- New `convertDocx(buffer)` returns `{ html, warnings }`. Calls
  `mammoth.convertToHtml({ buffer })`, wraps the value in `<article>`, maps each
  mammoth `messages[i].message` to a `'docx: ...'` warning string.
- New `convertPdf(buffer)` returns `{ html, warnings }`. Uses `pdfjs-dist/legacy/build/pdf.mjs`,
  iterates pages, runs the paragraph heuristic (below), wraps in `<article>`.
  Always emits a `'pdf: layout reconstructed by heuristics — review headings/lists manually'`
  warning.

`cli/src/commands.mjs`:
- `importCmd` switches `await fs.readFile(inputPath, 'utf8')` → `await fs.readFile(inputPath)`
  (Buffer). The result is passed straight into `convert(ext, bytes)`.

`cli/bin/rwa.mjs`:
- HELP: extend "Supported import formats" line with `.docx, .pdf`.

### Service (`service/public/import.html`)

- Two new cdnjs `<script>` tags with pinned SRI: `mammoth.browser.min.js` and
  `pdf.min.js`. Same `onerror` "failed to load — check your connection" pattern
  used for `marked` and `papaparse` today.
- Picker `accept` attribute and `handleFile` extension switch grow `.docx` and
  `.pdf` cases.
- For binary formats, replace `await file.text()` with `await file.arrayBuffer()`.
- Mirrored `convertDocx(arrayBuffer)` and `convertPdf(arrayBuffer)` ported from
  CLI. Browser-side mammoth takes `{ arrayBuffer }` instead of `{ buffer }`;
  pdf.js takes `{ data: arrayBuffer }`.
- Update the comment header from "PORTED FROM cli/src/seed.mjs and cli/src/commands.mjs"
  to reflect that `convertDocx` and `convertPdf` are also ported and must stay in
  sync. Note the four-sites-aligned rule.

### PDF paragraph heuristic

For each page in document order:
1. Get text items via `page.getTextContent()`. Each item has `str` and a
   `transform` matrix; `transform[5]` is the y-coordinate (PDF coords, origin
   bottom-left).
2. Sort items by descending `y`, then ascending `x` within a row.
3. Walk items: if `|y_curr - y_prev|` is within ~0.5 × line height, append `str`
   to the current line with a single space separator. Otherwise flush the
   current line into the current paragraph buffer.
4. If `|y_curr - y_prev|` exceeds ~1.5 × line height, flush the paragraph and
   start a new one.
5. Page boundary always flushes the current paragraph.

Line height defaults to a per-page median of inter-item y-deltas, falling back to
12 if unstable. Empty paragraphs are skipped. Output paragraphs are HTML-escaped
(`&` `<` `>`) and wrapped in `<p>...</p>`.

This is intentionally simple. It produces a usable starting point; column layout,
footers, page numbers, and tables will all come through as flat paragraphs that
the author cleans up via `⌘K`.

## Error handling

| Condition                                | Behavior                                                                                   |
|------------------------------------------|--------------------------------------------------------------------------------------------|
| Corrupt docx (mammoth throws)            | `rwa: docx: <mammoth message>`; exit 2.                                                    |
| Corrupt pdf (pdf.js throws)              | `rwa: pdf: <pdfjs message>`; exit 2.                                                       |
| Encrypted PDF (`PasswordException`)      | `rwa: pdf: file is password-protected`; exit 2. No prompt loop.                            |
| PDF with zero extractable text           | `rwa: pdf: no extractable text — this looks like a scanned/image PDF; OCR is not supported`; exit 2. |
| Mammoth `unrecognized style` messages    | Pass through as `rwa: note: docx: ...` on stderr, same channel as the HTML `<script>` warning today. |
| Browser: cdnjs script failed to load     | Existing `onerror` pattern updates the status line; user retries with connection.          |

Empty `<article>` is never emitted for docx/pdf — both error out instead. (Today
the CSV path returns `<article>\n</article>` for empty input; that's fine for
text formats but misleading for binary ones.)

## Sanitization

- Mammoth output is trusted: it produces a fixed vocabulary of HTML elements and
  attributes; no `<script>`, no inline event handlers. Wrapped verbatim in
  `<article>`.
- PDF text items are escaped (`&` `<` `>`) before being placed in `<p>` tags,
  matching the `.txt` path.
- Both pass through `replaceInlineDoc` unchanged. The splice layer doesn't grow
  any new logic.

## Versioning and SRI

- Pin specific versions in `cli/package.json` (e.g. `"mammoth": "1.8.0"`,
  `"pdfjs-dist": "4.x"`). Browser-side cdnjs URLs use the same versions.
- Compute SRI hashes per the recipe already in `service/public/import.html`:
  ```
  curl -sL https://cdnjs.cloudflare.com/ajax/libs/<lib>/<ver>/<file>.min.js \
    | openssl dgst -sha512 -binary | openssl base64 -A
  ```
- When CLI deps bump, bump the cdnjs version + SRI together. Same discipline as
  marked / papaparse today; this is restated in the comment header.

## Testing

CLI has no test harness today. Add a minimal one:
- `cli/test/import.test.mjs` using `node:test`.
- `cli/test/fixtures/sample.docx` — a small docx with one heading, one
  paragraph, one bullet list, one bold span. Hand-authored or generated once.
- `cli/test/fixtures/sample.pdf` — a small text-native PDF with two paragraphs
  and a forced page break. Hand-authored or generated once.
- Tests assert: `convert('docx', bytes)` returns HTML with exactly one `<h1>`,
  ≥1 `<li>`, ≥1 `<strong>`, no `<script>`. `convert('pdf', bytes)` returns
  exactly N paragraphs and no `<script>`. Run via `npm test` in `cli/`.

`tests/` (the seed/runtime jsdom harness) is unchanged — these converters never
touch the runtime, only the splice input.

`benchmark/` is unchanged — fidelity benchmarks measure the modify pathway, not
import.

Service: manual smoke test. Drop a docx, drop a pdf, open the resulting `.html`,
verify render. Same as `/import` is verified today.

## Rollout

Three commits, ordered so each can be reviewed independently:

1. **CLI**: deps + `convertDocx` + `convertPdf` + bytes-not-text shift in
   `importCmd` + HELP update + fixtures + tests.
2. **Service**: cdnjs pins with SRI + arrayBuffer path + mirrored converters +
   comment-header update.
3. **CLAUDE.md**: update the supported-formats line in the `cli/` and `service/`
   sections; update the "ports three pieces" comment in the service-conventions
   section to reflect the four-sites-aligned rule and the new converters.

No version bumps to the spec or to `rwa-edit-spec.md` — this is purely an import
surface change. `cli/package.json` minor bump (0.2.0 → 0.3.0) at publish time.

## Risks and mitigations

| Risk                                                              | Mitigation                                                                          |
|-------------------------------------------------------------------|-------------------------------------------------------------------------------------|
| pdf.js bundle adds noticeable weight to the npm package           | Accepted; the use case justifies it. Bundle is dev-time only for CLI users.          |
| Mammoth produces unstyled HTML that looks bad in the dark theme   | The author runs `⌘K` to clean up; explicit per design.                              |
| PDF heuristic produces garbled paragraph breaks                   | Documented in warning string; `⌘K` cleanup is the recovery path.                    |
| CLI / service converters drift                                    | "Four sites must stay aligned" rule documented in CLAUDE.md and in the comment header of `service/public/import.html`. |
| Encrypted / corrupt files crash the CLI                           | All known throwing paths translated to `exitCode = 2` with a clear message.         |
| cdnjs doesn't host a usable browser build of one of the libs      | Verify before committing the service change; both are well-known cdnjs libraries.   |

## Open questions

None blocking. Two minor calls deferred to implementation:

- Exact `pdfjs-dist` import path (`legacy/build/pdf.mjs` vs `build/pdf.mjs`)
  depends on Node version and whether worker spawning works in our context;
  pick whichever runs cleanly in `node >=18` without a worker.
- Whether to surface mammoth's `unrecognized style` warnings on stderr by
  default or behind a flag. Default: surface them; the user has explicitly
  said `⌘K` cleanup is the strategy and warnings help calibrate that pass.
