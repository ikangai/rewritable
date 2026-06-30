# Import visual judge — browser-side fidelity compare (increment 2, design)

Date: 2026-06-30. Status: **2a + 2b + 2c (the VLM judge) BUILT**; only the in-browser "Improve fidelity" re-import remains deferred. Follows increment 1 (CLI structural check + auto-escalate, `2026-06-30-import-fidelity-loop-design.md`). This is the *picture-level* "how close visually" answer — it needs a renderer, so it lives in the browser import (`service/public/import.html`), which already has pdf.js and a live DOM.

## UX

On the **`/import` page**, after conversion finishes but **before save** (the one moment the original is still in the browser). Two tiers by cost:

**Free (offline, always-on):**
- **Per-page structural badge** — increment 1's score, per page: *"Text fidelity 98%."*
- **Visual compare, your own eyes** — the original page (pdf.js → canvas) shown **over** the imported page (rendered live) via a **slider/curtain** (drag the divider to wipe between them) plus a **flicker toggle** (blink between the two — the eye catches drift). Both built from the two renders; no model, no upload.

**Opt-in (your API key, consent-gated, announced before any call):**
- **Score & diagnose** — send the two rendered images of a page to a vision model → a closeness number **and specific findings** (*"table border p.2 missing," "header heavier," "column shifted ~12px"*).
- **Improve fidelity** — re-import the whole doc via `--vision`, then re-render the compare.

## Multipage (the load-bearing detail)

- **Alignment 1:1** — imported page *i* ↔ source page *i* (geometry preserves page count + order).
- **Per-page structural** (offline) → page scores + overall (mean) + **worst page**. Trigger = any page below threshold.
- **Per-page fidelity strip** — jump to the low pages; the compare opens on the worst page.
- **VLM cost control** — structural per-page is free + always; the VLM judge is **on-demand per page** or auto-judges only the **lowest-K** pages. Never all N silently.
- **Mismatch** — if a `--vision` re-import yields a different page count, align by index to `min(N)` and flag extras.

## The comparison view

Ship the **slider/curtain + a flicker toggle** (both free, both on the two renders), with VLM findings (when run) as a short list beside the current page. Side-by-side and pixel-diff heatmap are deferred (heatmap is noisy under font substitution).

## Architecture

- **Data layer (testable, shared):** `structuralScoreByPage(perPageSource, perPageImportHtml)` in `cli/src/import-fidelity.mjs` → `{ pages:[{page, score, coverage, garble, reasons}], overall, worst }`. `convertPdf` surfaces per-page source text (extends increment 1's whole-doc `fidelityInput`). The CLI can report per-page too (`--json`).
- **Render layer (browser):** pdf.js `page.render()` → canvas for the original; the import's `.rwa-pdf-page` for the result; a curtain element clips the top layer to the slider position; flicker toggles `visibility`.
- **Judge layer (browser, opt-in):** a `judgePage(origPng, importPng, key)` that posts both images to the vision model (reusing the `--vision` OpenRouter path's transport shape) → `{ score, findings[] }`.

## Verification

- **Data layer** — unit-tested in `cli/tests/import-fidelity.test.mjs`: per-page alignment, worst-page, overall, a mixed good/garbled multi-page case.
- **Browser UI** — headless-Chromium smoke (the compare panel + per-page strip render and the structural strip populates from a stub import) + **operator browser-verify** for the actual slider/flicker visual (pixel rendering can't be asserted in jsdom — consistent with the repo's "browser-proven" UI pattern).
- **Judge** — key-gated (skipped without a key, honestly reported).

## Scope / not-this

- PDF only (the dual-render case). DOCX/HTML have no canonical original render — structural floor only.
- The free visual compare (slider/flicker) + per-page structural is the core; the VLM judge + improve are opt-in.
- No change to the deterministic import or the increment-1 CLI loop.

## Increment split

- **2a (this build, TDD):** the multipage structural data layer — `structuralScoreByPage` + `convertPdf` per-page source surfacing + CLI per-page reporting. Pure, fully tested. This is what makes multipage real.
- **2b (browser UI) — BUILT.** `service/public/import.html` gains: the scorer port (`structuralScore`/`structuralScoreByPage`, parity-pinned by `cli/tests/import-fidelity-port.test.mjs`), `convertPdf` per-page surfacing, `rasterizeOriginal` (pdf.js → canvas), and `buildFidelityCompare` — a per-page fidelity strip (jump to low pages, opens on the worst) + a slider/curtain + flicker over original-canvas vs import-render, shown after a PDF import. Headless-verified by `tests/import-visual-judge.mjs` (10/0: strip, worst-page default, slider/flicker DOM, the `window.__fidProbe` verdict, graceful rasterize-degrade, page-switch). **Operator-verify boundary:** the actual pdf.js pixel rasterization + the visual overlay alignment need a real browser/canvas (the jsdom harness exercises everything else). Ships via a service deploy (not npm).
- **2c (opt-in VLM judge) — BUILT.** `service/public/import.html` gains `judgePage(origDataUrl, importDataUrl, {key, model})` — posts the two page renders to an OpenRouter vision model → `{ score, findings[] }` (response parsing split into `parseJudge`: tolerates fenced/prose-wrapped JSON, clamps the score 0–100, normalizes findings). A **"Score & diagnose (VLM)"** button per page (consent-gated, announced before any call, key from sessionStorage `rwa_apikey` or a one-time prompt) rasterizes the original (pdf.js canvas → PNG) + the import (`rasterizeImport` via SVG foreignObject → PNG) and renders the score + a findings list. Headless-tested by `tests/import-judge.mjs` (11/0: request shape — vision model, both images original-first, Bearer auth — + parsing + no-key/HTTP-error throws, all via a stub fetch). **Operator/key-verify:** the foreignObject rasterization + the real OpenRouter call need a real browser + a key. Browser-only (no CLI mirror — the CLI has no renderer).
- **Deferred:** the in-browser **"Improve fidelity"** (re-import the whole doc via the model in-page) — that needs a full in-browser vision importer (a larger, separate feature, distinct from the judge); the CLI already offers `rwa import --vision`.
