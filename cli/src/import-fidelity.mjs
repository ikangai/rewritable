// Import fidelity loop — increment 1 (docs/plans/2026-06-30-import-fidelity-loop-design.md).
// An OFFLINE structural check on a PDF import + auto-escalate UP the ladder (default → --vision)
// when fidelity is low — gated on offline-first: escalation fires only when a model is reachable;
// a keyless low-fidelity import stays offline and warns, never touching the network.
//
// Increment 1 measures two false-positive-free signals:
//   - coverage: fraction of source word-tokens present in the imported text (transform fidelity —
//               catches dropped/mangled content; ~1 for a faithful geometry import).
//   - garble:   1 − share of replacement (U+FFFD) / control chars in the source (extraction
//               quality — a PDF with broken font encoding extracts to garbage; the geometry import
//               is then unfaithful and should escalate to --vision, which reads the rendered glyphs).
// The graphics/visual signal ("this page is a chart/scan the text import can't reproduce") needs a
// renderer; it is the browser-side VISUAL JUDGE, a later increment. `density` is reported for
// visibility but deliberately NOT scored here (char-count alone false-positives on short docs).

const DEFAULT_THRESHOLD = 0.85;
const MIN_CHARS_PER_PAGE = 200; // informational density floor only (not part of the score in inc. 1)

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
const stripTags = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, ' ');

// Count replacement (U+FFFD) + control chars (excluding tab/LF/CR) without embedding literal
// control bytes in source — a char-code scan, so the file stays clean ASCII.
function badChars(src) {
  let bad = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === 0xFFFD || (c < 0x20 && c !== 9 && c !== 10 && c !== 13)) bad++;
  }
  return bad;
}

/** Pure offline structural score in [0,1] = min(coverage, garble). Returns the components + reasons. */
export function structuralScore({ sourceText, pages } = {}, importedHtml) {
  const src = String(sourceText == null ? '' : sourceText);
  const importText = norm(stripTags(importedHtml));

  // coverage — unique source word-tokens (len>1) present in the imported text
  const tokens = [...new Set(norm(src).split(' ').filter(t => t.length > 1))];
  let coverage = 1;
  if (tokens.length) {
    let hit = 0;
    for (const t of tokens) if (importText.includes(t)) hit++;
    coverage = hit / tokens.length;
  }

  // garble — replacement + control char share of the source
  const garble = src.length ? Math.max(0, 1 - badChars(src) / src.length) : 1;

  // density — reported only (graphics-heaviness detection is the deferred visual judge)
  const pageN = Math.max(1, pages | 0);
  const density = Math.min(1, src.replace(/\s+/g, '').length / (pageN * MIN_CHARS_PER_PAGE));

  const score = Math.min(coverage, garble);
  const reasons = [];
  if (coverage < 0.9) reasons.push('low-coverage');
  if (garble < 0.9) reasons.push('garbled-text');
  return { score, coverage, garble, density, reasons };
}

/**
 * Per-page structural fidelity for a multipage import. `perPage`: [{ sourceText, html }], where
 * imported page i aligns 1:1 with source page i (the geometry import preserves page order). Returns
 * { pages:[{page, score, coverage, garble, reasons}], overall (mean), worst (the lowest page) }.
 * The per-page strip is what the browser visual judge surfaces so you jump to the bad pages.
 */
export function structuralScoreByPage(perPage = []) {
  const pages = perPage.map((p, i) => ({ page: i + 1, ...structuralScore({ sourceText: p.sourceText, pages: 1 }, p.html) }));
  const overall = pages.length ? pages.reduce((a, p) => a + p.score, 0) / pages.length : 1;
  const worst = pages.length ? pages.reduce((w, p) => (p.score < w.score ? p : w)) : null;
  return { pages, overall, worst };
}

// The escalate-trigger fidelity: the WORST page when per-page data is present (so one bad page in an
// otherwise-good doc still escalates — averaging would hide it), else the whole-doc score.
function measureStructural(structuralInput, importHtml) {
  if (structuralInput && Array.isArray(structuralInput.perPage) && structuralInput.perPage.length) {
    const bp = structuralScoreByPage(structuralInput.perPage);
    return { score: bp.worst.score, coverage: bp.worst.coverage, garble: bp.worst.garble, reasons: bp.worst.reasons, overall: bp.overall, worst: bp.worst, pages: bp.pages };
  }
  return structuralScore(structuralInput, importHtml);
}

/**
 * Measure the geometry import; if its score is below `threshold` AND escalation is enabled AND a
 * model is reachable, re-import via the injected `visionImport` and keep the higher-rung result.
 * Offline-first: with no reachable model, never call the network — keep the deterministic import and
 * surface a warning `note`. A failed escalation falls back to the deterministic import (loud).
 *
 * deps: { threshold=0.85, escalate=true, modelReachable():boolean, visionImport():Promise<importResult> }
 */
export async function measureAndEscalate({ structuralInput, importResult }, deps = {}) {
  const threshold = deps.threshold == null ? DEFAULT_THRESHOLD : deps.threshold;
  const escalate = deps.escalate !== false; // default on
  const fidelity = measureStructural(structuralInput, importResult.html);

  if (fidelity.score >= threshold || !escalate) {
    return { result: importResult, fidelity, escalated: false };
  }

  const reachable = typeof deps.modelReachable === 'function' ? deps.modelReachable() : false;
  if (!reachable) {
    return {
      result: importResult, fidelity, escalated: false,
      note: 'low import fidelity (' + fidelity.score.toFixed(2) + (fidelity.reasons.length ? ': ' + fidelity.reasons.join(', ') : '') +
        ') — set RWA_OPENROUTER_KEY or use --vision/--claude for a higher-fidelity import',
    };
  }

  try {
    const vResult = await deps.visionImport();
    // Escalation succeeded: keep the higher rung. We do NOT re-score with the same text-only metric
    // — its blind spot (graphics/garbled glyphs) is exactly why we escalated; the model addresses it.
    return {
      result: vResult, escalated: true, baselineFidelity: fidelity,
      note: 'import fidelity ' + fidelity.score.toFixed(2) + ' — escalated to --vision',
    };
  } catch (e) {
    return {
      result: importResult, fidelity, escalated: false,
      note: 'low import fidelity (' + fidelity.score.toFixed(2) + ') — escalation to --vision failed: ' + ((e && e.message) || e),
    };
  }
}
