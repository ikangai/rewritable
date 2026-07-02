# PDF import — structural reconstruction (editable-yet-faithful)

- **Date:** 2026-07-02
- **Author:** agent-11
- **Status:** design (validated with the operator; not yet implemented)
- **Area:** PDF import fidelity — **agent-9's territory** (`cli/src/import.mjs`, `cli/src/import-fidelity.mjs`, `service/public/import.html`, the visual judge). This design keeps reconstruction in a **new** module so their pipeline is untouched until integration. Coordinate before touching their files.

## Motivating case study

An operator imported a real invoice PDF (kiumi `Rechnung_00018_2026`) via the geometry importer. It rendered with several defects that took a long manual editing session to fix in the browser:

- A **garbled billing row** — three table cells merged into one positioned `<span>` in the wrong reading order (a run-ordering bug in the extractor).
- **Text collisions** in the letter paragraph — the geometry importer positions each run at its exact PDF x-coordinate but renders with a *substitute* font (Georgia/Times); where that font is wider than the original, adjacent runs overlap ("Proje**KI**", "Apothekengru**ppe**…**Re**chnung"). Fixed by reflowing the runs into one flowing `<p>`.
- **Print margins** — export-to-PDF showed huge margins: (1) the seed's `@page{margin:18mm}` framing a page that already has its own margins, and (2) the page box stored in PDF **points** (72/in) but rendered as CSS **px** (96/in), so it drew at 75% of true A4. Fixed with a document-level `@page{size:A4;margin:0}` + `zoom:1.333` in `@media print` (verified via headless print-to-PDF: one A4 page, edge-to-edge).
- Every layout tweak (moving "Summe:" into the totals box, right-aligning the header date) meant **nudging x-coordinates** — brittle, and each on-disk edit was shadowed by the per-container IndexedDB cache until the `DOC_UUID` was rotated.

**The lesson:** the geometry import is faithful to the *pixels* but is a bag of absolutely-positioned spans — poorly editable, and prone to font-substitution collisions. The operator's real need for invoices is a **fixed layout they edit textually each month** (number, dates, amounts, a label or two; occasionally an extra line item).

## The key decision — structural fidelity over pixel fidelity

There are two notions of "faithful":

- **Pixel fidelity** — looks byte-for-byte like the source PDF. What the geometry import targets. Fights editability (positioned spans, coordinate nudging, font collisions).
- **Structural fidelity** — same rows/columns/alignment/emphasis, cleanly *re-typeset* as normal flowing HTML. Editable like any document.

For invoices we target **structural fidelity**. The original PDF remains the archival pixel-truth; the rewritable becomes the clean, correct, editable version. This trade *dissolves* the editable-vs-faithful tension — every time we chased pixel-perfect (Summe, the header) it fought editability; switching the target removes the fight. **Validated with the operator.**

## Architecture (option A — CLI reconstructs at import, deterministic + offline)

The existing geometry extractor stays; it stops being the *final* output and becomes the *input* to a reconstruction stage.

```
pdf.js extract → [runs + rules + fonts] → reconstructLayout() → structural model → emit hybrid HTML
                                    ↘ (per-region fallback) → geometry spans (today's output)
```

- **New module `cli/src/pdf-reconstruct.mjs`** — pure JS, offline, deterministic. Consumes the run/rule geometry `convertPdf` already computes; produces a *structural model* (regions typed table / paragraph / heading / block); emits **hybrid HTML** — nested `<table>` for grid regions, flowing `<p>`/`<h*>` for prose.
- **Offline-first preserved.** No network, no renderer on the import path. The model and the visual judge are opt-in layers on top, never required. This mirrors agent-9's `import-fidelity.mjs` pattern (offline floor + opt-in vision).

### Why the renderer is NOT needed to reconstruct

Reconstruction (grouping runs into cells/rows, inferring the table) is **pure geometry** — it needs run coordinates, fonts, and the drawn rules, all of which the CLI already has. A renderer/VLM is only needed to *verify* the result looks right. "Reconstruct" and "check it looks right" are separable; only the second needs a browser. This is what lets option A live entirely in the offline CLI.

## The reconstruction engine

Heuristics on the geometry; the model stays optional.

1. **Lines** — cluster runs by baseline (y within tolerance), sort by x. This alone fixes the garbled-billing-row bug: run order is *re-derived* from x rather than trusting the extractor's order.
2. **Columns** — cluster run x-starts *and right-edges* into column bands. **Drawn rules corroborate** boundaries; right-edge clustering detects **right-aligned number columns** (the €-amount alignment we hand-fixed).
3. **Regions** — group consecutive lines by vertical spacing + cues:
   - consistent left margin, normal spacing, continuous sentences → **prose** → flowing `<p>` (bold/italic runs → `<b>`/`<i>`). Reflow makes font-substitution overlap *impossible*.
   - 2+ stable columns, especially rule-bounded → **table** → `<tr>`/`<td>`, alignment preserved, colspans inferred from runs crossing bands.
   - side-by-side blocks (An: / Kontaktdaten:) → a 2-cell row.
   - lone larger/bold line → **heading**.
4. **Spacing** — carry the original vertical gaps into margins/padding so the result still *feels* like the source.

### Confidence + per-region fallback (the safety net)

Because option A ships without on-path visual verification, **every region gets a confidence score** (how cleanly runs snap to columns, whether rules corroborate, spacing regularity). A **low-confidence region falls back to positioned spans** for that region only — so a doc is editable tables/prose with, at worst, a geometry island where we weren't sure. Never garbage.

### Model = opt-in only

For genuinely ambiguous calls (table vs aligned prose, heading hierarchy, colspan inference), an opt-in LLM pass can *label* regions. The deterministic heuristics are the offline core. Invoices give strong signals (rules, stable columns, right-aligned totals) that make them the tractable first target.

## Output representation & the payoff

Hybrid HTML, no absolute coordinates for reconstructed regions: a normal `<article>` with nested `<table>` for grid regions, `<p>`/`<h*>` for prose; `.rwa-pdf` absolute-positioning survives only around geometry-fallback islands.

**It drops straight into the substrate's edit model** — `<td>`, `<p>`, `<h*>`, `<li>` are already in `ANCHORABLE_TAGS`, so inline text editing, lens anchoring, and rwa-edit anchors work with zero new machinery. The monthly edit becomes normal document editing; an extra line item is a `<tr>` insert via the DSL. No coordinate nudging, no Summe-into-the-box surgery.

**Styling:** minimal, semantic — borders only where the original drew rules, right-aligned amount cells, spacing from the original gaps; leans on the substrate baseline typography plus a small scoped `<style>` for invoice-specific bits.

**Print gets simpler:** reconstructed docs are real flowing content at true size, so the 72→96 zoom hack **disappears** — they print at A4 under the seed's normal print stylesheet. The `@page{margin:0}`+zoom fix remains only for pure-geometry imports and fallback islands.

## The deterministic print fix (separate, immediate)

Independent of reconstruction: the geometry emitter (`PDF_PAGE_STYLE`, `cli/src/import.mjs` ~L313–318, mirrored in `service/public/import.html`) should emit A4-correct print CSS unconditionally —

```
@page{size:A4;margin:0}
@media print{…;.rwa-pdf-page{box-shadow:none;zoom:1.333}}
```

(zoom = 96/72; verified single-page, edge-to-edge via headless print-to-PDF). This fixes export-to-PDF for *all* geometry imports today, before reconstruction lands.

## Verification (opt-in QA, off the critical path)

Reuse agent-9's per-page rasterize-and-compare. Two hosts:

- **First-open in the browser** (renderer present), or
- **CLI `--verify`** that shells to headless Chrome (present on the machine — used for the print test) to rasterize reconstruction vs the original PDF page, score, flag low-confidence regions.

Never required; the offline core stands alone. A flagged region feeds a **bounded, targeted** re-reconstruction (re-split a column, toggle table↔prose) or surfaces the region and offers geometry fallback for it.

## Testing (offline, deterministic — the core)

- Golden real invoices → assert the *structural model* (region types, column count, table shape, right-align flags) with no renderer.
- Round-trip editability: reconstructed doc passes `rwa doc`/`edit` anchoring on its cells.
- `overlap == 0` invariant on reconstructed output.
- Reuse `structuralScore` (agent-9) for content-coverage regression — nothing dropped.
- "Does it *look* right" is the visual judge's separate, opt-in test.

## Rollout (incremental, zero regression)

Opt-in `rwa import --editable` flag (name TBD) → dogfood on the operator's real kiumi invoices → flip to default when reliable → mirror shared reconstruction logic into `import.html` only after the CLI proves it. Today's proven geometry import stays the default throughout.

## Relationship to existing work

- `cli/src/import-fidelity.mjs` (agent-9) — offline `structuralScore` + `measureAndEscalate`. Reused for coverage regression; the escalation ladder is complementary (this adds a *structural* rung below `--vision`).
- The browser visual judge (`service/public/import.html`, `docs/plans/2026-06-30-import-visual-judge-design.md`) — reused as the opt-in QA host.
- Keeps reconstruction as a **new** module so the existing pipeline is untouched until integration.

## Deferred / open

- General (non-invoice) PDFs — invoices first; broaden once the heuristics prove out.
- Template/data separation ("extract a reusable invoice template + variable fields") — a possible v2; YAGNI for now, an editable hybrid doc satisfies the monthly-edit workflow.
- The `--verify` headless-Chrome dependency — opt-in only; decide whether to gate it behind a probe like `modelReachable()`.
- docx import — out of scope for this design (geometry reconstruction is PDF-specific).
