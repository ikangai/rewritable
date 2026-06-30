# Import fidelity loop — measuring how close an import is to the original (design)

Date: 2026-06-30. Status: **increment 1 (CLI structural check + auto-escalate) BUILT**; the browser-side visual judge is the next increment. Origin: "how about a fidelity loop for the import? rwa should check the quality of the imported document — how close is it visually to the original?"

> **Increment 1 (built):** `cli/src/import-fidelity.mjs` — `structuralScore` (coverage + garble; offline) + `measureAndEscalate` (auto-escalate to `--vision` only when a model is reachable; keyless stays offline + warns; failed escalation falls back loud). Wired through `convertPdf` (`fidelityInput`) → `importCmd` → bin (`--no-escalate`, `--target-fidelity`). Pinned by `cli/tests/import-fidelity.test.mjs` (9/0); full CLI suite 501/0. Scoped to coverage + garble (false-positive-free); the density/graphics signal is deferred to the visual judge (needs a renderer). CLI-only — the conversion output is unchanged, so the import.html mirror's output-parity holds.

## Problem & existing implementation (surveyed first)

`rwa import` has **no fidelity check today**. (The `benchmark/` "fidelity" harness measures something different — *edit-loop* fidelity: does the agent preserve the doc through ⌘K.) The PDF import path is already a quality **ladder**, trading cost for visual accuracy:

1. **default** — `convertPdf` → `renderPdfPage`: a *geometry-faithful reconstruction* (pdf.js text items → absolutely-positioned `<span>`s at device coords; vector rules → `<div>`s). Offline, deterministic, editable.
2. **`--vision`** — send the PDF to an OpenRouter VLM (`cli/src/import-vision.mjs`).
3. **`--claude`** — spawn `claude -p` (`cli/src/import-claude.mjs`).

The pieces a check needs already exist: **pdf.js** rasterizes the *original* page; the repo routinely screenshots `.html` via **headless Chromium**. DOCX/HTML/MD/CSV/TXT have no canonical "original render," so **PDF is the first target** — and it is where the geometry rework landed and where visual fidelity matters most.

## Decisions (with the operator)

- **Signal:** structural (offline, always-on) **+ optional VLM visual judge** — not pure SSIM, not VLM-only.
- **Loop:** **auto-escalate** on a low score — *reconciled with offline-first* (below).

## The offline-first reconciliation (load-bearing)

CLAUDE.md makes `rwa import` **offline-first**. Unconditional auto-escalate would make a plain `rwa import file.pdf` fire a network model call — breaking that invariant. So:

- Auto-escalate fires **only when a model is already reachable** — a key is configured (`RWA_OPENROUTER_KEY` for `--vision`) or the `claude` CLI is present. Keyless imports stay **fully offline**: deterministic import + structural score + a warning, never a network call.
- The escalation is never *silent* — it's gated on the user's own credentials and announced on stderr (`fidelity 0.71 — escalating to --vision (model X)…`).
- Controls: `--no-escalate`, `--target-fidelity <n>` (threshold), and `--vision`/`--claude` still force a rung directly.

## The metric

### (a) Structural fidelity — offline, always-on, CLI

The geometry import is a transform of pdf.js text items, so compare the import against the *source's own extraction* — no rendering required:

- **Text coverage** — normalize (collapse whitespace, NFC) the source text and the imported DOM's text; `score_text = covered / total`. Catches dropped / garbled text.
- **Position sanity** — each source text item became a span at coords derived from it; measure bbox IoU (import-span vs source-item) and flag degenerate layouts (everything at 0,0; huge overlap clusters). Catches placement bugs.
- Combine → `structural ∈ [0,1]`; below a tunable threshold (default ~0.85) → escalate trigger.

**Honest limit:** the structural check reliably catches *content/layout* failures but **not** purely *visual* ones (font substitution, glyph/overlap issues) — because the import is a faithful transform of the items. Visual problems need (b).

### (b) Visual fidelity — the true "how close visually," needs a renderer

Rasterize the **original** (pdf.js `page.render()` → canvas → PNG) and the **import** (render the result HTML → PNG), then a **VLM judge** scores 0–100 closeness **and names what is wrong** (missing rule, shifted column, wrong font). The diagnosis is the point — far more useful than a bare SSIM number (SSIM is also depressed by unavoidable font substitution). When the judge is available it becomes the escalate trigger (a truer signal than structural).

## Where each check runs (honest split by surface)

- **CLI (`rwa import`)** has no bundled browser → runs **(a) structural** + auto-escalates to `--vision` (which sends the PDF to a VLM — no browser needed). The visual judge runs in the CLI **only if** a system Chrome is detectable (`puppeteer-core` + a discovered Chrome path); otherwise it is skipped — degrade, never fail.
- **Browser import (`service/public/import.html`) + the seed runtime** already have a live browser **and** pdf.js loaded → the **full visual judge (a + b)** lives there: rasterize the source page, render the result, SSIM and/or VLM. This is the richest "how close visually" home.

## Pipeline

CLI: `convert()` → structural score → if `< threshold` **and** a model is reachable: re-import via `--vision` and **keep the escalated (higher) rung** (we don't re-score the model result with the same text-only metric — its blind spot is exactly why we escalated); a failed escalation falls back to the deterministic import, loud. New module `cli/src/import-fidelity.mjs` (measure + escalate orchestration), invoked by `importCmd` after `convert`. The browser-side check extends `service/public/import.html`.

> **As built (not the original sketch):** the offline score is `min(coverage, garble)` only — `density` is computed but not scored (char-count alone false-positives on short docs) and not yet surfaced. There is **no `--json` fidelity output** in `importCmd` today (an earlier draft of this doc claimed one); escalation is reported on stderr. A structured `--json` surface (and surfacing `density`) is future work — until then `density` is dead and should either be wired up or removed (Rule 2).

## Scope

- **PDF first** (clean dual-render; where the geometry path lives).
- DOCX / HTML get the **structural text-coverage floor only** (no canonical original render); their visual judge is explicit future work — *not* silently skipped (Rule 12).
- No change to `rwa new`. The keyless `rwa import` stays offline + deterministic.

## Testing

- **Structural math** — unit-tested directly (coverage + IoU on synthetic item/span sets).
- **Calibration** — reuse `benchmark/`: a small fixture set of PDFs with known-good imports pins the structural metric (deterministic, offline) so the ~0.85 threshold is calibrated, not guessed.
- **Escalation** — injected transport (like `publish-site.test.mjs`) so the loop is tested offline: a stub "model" returns a higher-fidelity HTML; assert the loop measures, escalates, and keeps the better rung; and that **keyless → no network, warn only**.
- **VLM judge** — key-gated test against a couple of fixtures (skipped without a key, honestly reported).

## What this is NOT

- Not a change to the deterministic geometry import itself (that is the fast path; the loop *measures* and *escalates*, it does not replace it).
- Not a hard quality gate that fails the import — a low-fidelity import still succeeds (with a warning); the user is never blocked from getting *some* editable result.
- Not DOCX/HTML visual fidelity (yet) — structural floor only there.

## Implementation seams (for the build)

- `cli/src/import.mjs` `convertPdf` already parses pdf.js text items — surface them (or re-parse) for the structural compare.
- `cli/src/import-fidelity.mjs` (new): `structuralScore(sourceItems, importedHtml)`, `measureAndEscalate(importResult, opts, deps)` (deps inject the `--vision` transport + the model-reachable probe).
- `cli/bin/rwa.mjs` import dispatch: add `--no-escalate` / `--target-fidelity`; thread the model-reachability probe.
- `service/public/import.html`: in-page rasterize + score (the visual home).
