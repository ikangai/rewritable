// benchmark/oracles/coherence.mjs — TRAJECTORY coherence scorer (issue #22).
//
// benchmark/'s other scorers judge a SINGLE transformation: import-facts.mjs
// scores one converter pass, the fidelity oracles (diff.mjs/selector.mjs)
// score one modify() call. This module scores a CUMULATIVE property instead:
// given a document before an N-edit sequence and the same document after,
// does the END state look structurally healthy? Per-edit fidelity can be
// perfect on every individual commit while heading hierarchy, class-name
// bloat, dead CSS, duplicate ids, and markup-vs-text growth all drift
// monotonically across the sequence — this is the thing nothing else in the
// repo measures.
//
// scoreCoherence(startDoc, endDoc) is MODEL-FREE and DETERMINISTIC: it is a
// pure function of the two document strings, no network, no LLM judge. Both
// arguments are HTML fragments in the shape #rwa-doc-mount holds (not full
// pages) — the same shape run-fidelity.mjs's harness.getDoc() returns.
//
// Five dimensions, each scored 0..1 where 1 is healthy. Following
// import-facts.mjs's lead, this header is candid about what each dimension
// CAN and CANNOT see — none of them is a full linter, and none of them
// understands document semantics:
//
//   - headings    Outline well-formedness of the END doc ONLY: does any
//                 heading level jump by more than one from the heading
//                 immediately before it (h1 -> h3), and are there multiple
//                 h1s. Score = 1 - violations/heading_count (1 if there are
//                 no headings at all — nothing to be wrong about).
//                 CANNOT see: headings that were REMOVED during the
//                 trajectory (an end doc with zero headings scores a trivial
//                 1, even if the start doc had a healthy outline that the
//                 edits deleted); heading TEXT quality; a level jump that
//                 happens to read fine after other headings were removed in
//                 between (this only looks at adjacency in the FINAL doc).
//
//   - classChurn  Class-name bloat accumulated relative to the start doc —
//                 the sk-*/wrapper-accretion signal. Two components, averaged:
//                 (a) the RISE (end minus start, floored at 0) in the fraction
//                 of distinct class names used on exactly one element — a
//                 swarm of one-off classes is the signature of "wrap it
//                 again" edits that never reuse or clean up a prior class,
//                 and comparing against the start (rather than scoring the
//                 end state's raw fraction) means a document that was always
//                 small and mostly single-use classes isn't flagged just for
//                 being small; and (b) growth in distinct class COUNT end vs
//                 start.
//                 CANNOT see: which INDIVIDUAL classes are new vs pre-existing
//                 (only the aggregate fraction/count move) — a document that
//                 drops several old single-use classes while adding just as
//                 many new ones looks unchanged to (a); intentional,
//                 well-factored new classes that happen to apply to one
//                 element today read the same as accretion junk.
//
//   - deadStyles  CSS selectors declared in <style> blocks in the END doc
//                 that match nothing in the END doc. Selector extraction is
//                 PARSER-FREE by design (matching this repo's house style —
//                 see CLAUDE.md's "parser-free" DSL/import precedents): a
//                 brace-depth scanner pulls out top-level rules and keeps
//                 only selectors that are a single simple `.class`, `#id`, or
//                 `tag` token (after splitting comma lists). This is NOT a
//                 CSS parser. It does NOT attempt combinators (`.a .b`,
//                 `.a > .b`), compound selectors (`div.a`), pseudo-classes/
//                 elements (`:hover`, `::before`), attribute selectors
//                 (`[data-x]`), or anything nested inside an at-rule
//                 (`@media`, `@supports`, `@keyframes` bodies are walked past
//                 but never descended into) — all of those are silently left
//                 UNSCORED rather than guessed at or flagged as false dead
//                 style. If a doc has no <style> block, or every selector in
//                 it is one of the unscored shapes above, this dimension
//                 reports a trivial 1 ("nothing this scorer can evaluate"),
//                 which is an honest "unknown", not a claim of health.
//
//   - idHygiene   Duplicate `id` and duplicate `data-rwa-id` attribute values
//                 in the END doc (both are supposed to be unique — the
//                 latter is the runtime's own stable-block-id namespace,
//                 CLAUDE.md's "Reserved namespaces"). Score = 1 minus the
//                 fraction of id-bearing elements that collide with another
//                 element's id, averaged with the same measure for
//                 data-rwa-id.
//                 CANNOT see: WHEN a duplicate was introduced, or whether a
//                 duplicate data-rwa-id is one the runtime would have
//                 corrected on its next commit (this scores the doc as
//                 handed to it, nothing more).
//
//   - growth      Markup growth vs visible-TEXT growth from start to end — a
//                 document whose tag bytes grow much faster than its visible
//                 text is accreting wrappers rather than content. Computed as
//                 tagDelta / (max(0, textDelta) + a smoothing constant), so a
//                 flat/negative text delta doesn't produce a divide-by-~0
//                 blowup and small incidental markup changes (a handful of
//                 attribute edits) aren't over-penalized. Ratio <=1 (markup
//                 grew no faster than text, or shrank) scores 1; ratio grows
//                 toward a ceiling where the score bottoms at 0. If markup
//                 didn't grow at all, this dimension is trivially 1 — a
//                 shrinking or flat document is never a wrapper-accretion
//                 signal by this measure, whatever happened to its text.
//                 CANNOT see: "bytes" here are JS string length (UTF-16 code
//                 units), not a true byte count, and <script>/<style> content
//                 is excluded from the text measure but still counts as
//                 "markup" — this is a length heuristic, not a semantic
//                 content-value judgment. It also only sees the NET
//                 start->end change, not whether growth was monotonic or
//                 happened to cancel out mid-trajectory (a document that grew
//                 wrappers on edit 10 and had them stripped on edit 40 looks
//                 identical to one that never grew at all).
//
// Benchmark-only: nothing in this file ships in the CLI or the seed.

import jsdomPkg from 'jsdom';
const { JSDOM } = jsdomPkg;

export const DIMENSIONS = ['headings', 'classChurn', 'deadStyles', 'idHygiene', 'growth'];

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function domOf(html) {
  return new JSDOM('<!DOCTYPE html><html><body>' + html + '</body></html>').window.document;
}

// ─── headings ───────────────────────────────────────────────────────────

function scoreHeadings(document) {
  const levels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((el) => +el.tagName[1]);
  if (levels.length === 0) {
    return { score: 1, note: 'headings: no headings present (nothing to evaluate)' };
  }
  let violations = 0;
  const detail = [];

  const h1Count = levels.filter((l) => l === 1).length;
  if (h1Count > 1) {
    violations += h1Count - 1;
    detail.push(`${h1Count} h1 elements (expected at most 1)`);
  }

  let jumps = 0;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] > levels[i - 1] + 1) jumps++;
  }
  if (jumps > 0) {
    violations += jumps;
    detail.push(`${jumps} level jump(s) (a heading more than one level deeper than the one before it)`);
  }

  const score = clamp01(1 - violations / levels.length);
  const note = `headings: ${violations} violation(s) across ${levels.length} heading(s)` +
    (detail.length ? ' — ' + detail.join('; ') : '');
  return { score, note };
}

// ─── classChurn ─────────────────────────────────────────────────────────

function extractClasses(document) {
  const classes = [];
  for (const el of document.querySelectorAll('[class]')) {
    for (const c of (el.getAttribute('class') || '').split(/\s+/).filter(Boolean)) classes.push(c);
  }
  return classes;
}

const CLASS_GROWTH_CEILING = 3;   // distinct class count TRIPLING vs start bottoms this half of the score
const SINGLE_USE_CEILING = 0.5;   // a 50-percentage-point RISE in single-use fraction bottoms the other half

function singleUseFractionOf(document) {
  const classes = extractClasses(document);
  const distinct = new Set(classes);
  const freq = new Map();
  for (const c of classes) freq.set(c, (freq.get(c) || 0) + 1);
  const singleUse = [...freq.values()].filter((n) => n === 1).length;
  return { distinct, singleUse, fraction: distinct.size ? singleUse / distinct.size : 0 };
}

function scoreClassChurn(startDocument, endDocument) {
  const start = singleUseFractionOf(startDocument);
  const end = singleUseFractionOf(endDocument);

  // Only a RISE in the single-use fraction relative to the start counts as
  // churn. Scoring the end state's raw fraction would flag any small,
  // naturally simple document (few classes, each on one element — common in
  // small fixtures) as "bloated" even with zero edits; comparing against the
  // start makes this a measure of what the TRAJECTORY did, not of document
  // size.
  const singleUseDelta = Math.max(0, end.fraction - start.fraction);
  const singleUseScore = clamp01(1 - singleUseDelta / SINGLE_USE_CEILING);

  let growthRatio;
  if (start.distinct.size === 0) {
    growthRatio = end.distinct.size === 0 ? 1 : Infinity;
  } else {
    growthRatio = end.distinct.size / start.distinct.size;
  }
  const growthScore = growthRatio === Infinity
    ? 0
    : clamp01(1 - Math.max(0, growthRatio - 1) / (CLASS_GROWTH_CEILING - 1));

  const score = (singleUseScore + growthScore) / 2;
  const ratioStr = growthRatio === Infinity ? '∞' : growthRatio.toFixed(2);
  const note = `classChurn: single-use class fraction ${(end.fraction * 100).toFixed(0)}% ` +
    `(was ${(start.fraction * 100).toFixed(0)}%); distinct class count ${end.distinct.size} vs start ${start.distinct.size} (x${ratioStr})`;
  return { score, note };
}

// ─── deadStyles ─────────────────────────────────────────────────────────

// Single simple selector: `.class`, `#id`, or a bare tag name. Anything else
// (combinators, compounds, pseudo-*, attribute selectors, universal `*`) is
// left unrecognized on purpose — see the file header.
const SIMPLE_SELECTOR_RE = /^(\.[A-Za-z0-9_-]+|#[A-Za-z0-9_-]+|[A-Za-z][A-Za-z0-9]*)$/;

// Parser-free rule splitter: a brace-depth scan that only extracts selectors
// sitting at depth 0 (top-level rules). A rule whose selector text starts
// with '@' is an at-rule (@media/@supports/@keyframes/@font-face/...) — its
// own "selector" position is a condition, not a selector, so it's skipped;
// its BODY sits at depth 1+ and is walked past, never descended into, so
// selectors nested inside at-rules are never extracted (documented above).
function extractSimpleSelectors(cssText) {
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors = [];
  let depth = 0;
  let selectorStart = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        const selectorText = clean.slice(selectorStart, i).trim();
        if (selectorText && !selectorText.startsWith('@')) {
          for (const part of selectorText.split(',')) {
            const sel = part.trim();
            if (SIMPLE_SELECTOR_RE.test(sel)) selectors.push(sel);
          }
        }
      }
      depth++;
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) selectorStart = i + 1;
    }
  }
  return selectors;
}

function scoreDeadStyles(document) {
  const styleBlocks = [...document.querySelectorAll('style')].map((el) => el.textContent || '');
  const selectors = styleBlocks.flatMap(extractSimpleSelectors);
  if (selectors.length === 0) {
    return {
      score: 1,
      note: 'deadStyles: no simple selectors found to evaluate (no <style> block, or only complex/at-rule selectors — unscored, see header)',
    };
  }
  const dead = [];
  for (const sel of selectors) {
    let matched = null;
    try { matched = document.querySelector(sel); } catch { /* SIMPLE_SELECTOR_RE should prevent this */ }
    if (!matched) dead.push(sel);
  }
  const score = clamp01(1 - dead.length / selectors.length);
  const preview = dead.slice(0, 5).join(', ') + (dead.length > 5 ? ', …' : '');
  const note = `deadStyles: ${dead.length}/${selectors.length} simple selector(s) matched nothing` +
    (dead.length ? ` (${preview})` : '');
  return { score, note };
}

// ─── idHygiene ──────────────────────────────────────────────────────────

function freqOf(document, attr) {
  const freq = new Map();
  for (const el of document.querySelectorAll(`[${attr}]`)) {
    const v = el.getAttribute(attr);
    if (v) freq.set(v, (freq.get(v) || 0) + 1);
  }
  return freq;
}

function scoreIdHygiene(document) {
  const idFreq = freqOf(document, 'id');
  const rwaFreq = freqOf(document, 'data-rwa-id');

  const totalIds = [...idFreq.values()].reduce((a, b) => a + b, 0);
  const idViolations = [...idFreq.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);
  const totalRwa = [...rwaFreq.values()].reduce((a, b) => a + b, 0);
  const rwaViolations = [...rwaFreq.values()].reduce((a, n) => a + Math.max(0, n - 1), 0);

  const idScore = totalIds ? clamp01(1 - idViolations / totalIds) : 1;
  const rwaScore = totalRwa ? clamp01(1 - rwaViolations / totalRwa) : 1;
  const score = (idScore + rwaScore) / 2;

  const dupIds = [...idFreq.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const dupRwa = [...rwaFreq.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const note = `idHygiene: ${dupIds.length} duplicate id value(s)` +
    (dupIds.length ? ` (${dupIds.slice(0, 5).join(', ')})` : '') +
    `, ${dupRwa.length} duplicate data-rwa-id value(s)` +
    (dupRwa.length ? ` (${dupRwa.slice(0, 5).join(', ')})` : '');
  return { score, note };
}

// ─── growth ─────────────────────────────────────────────────────────────

const GROWTH_SMOOTH_CHARS = 50; // avoids a divide-by-~0 ratio on a flat/negative text delta
const GROWTH_RATIO_CEILING = 3; // tagDelta at 3x the (smoothed) textDelta bottoms the score

function textLenOf(document) {
  const clone = document.body.cloneNode(true);
  for (const el of clone.querySelectorAll('script,style')) el.remove();
  return clone.textContent.replace(/\s+/g, ' ').trim().length;
}

function scoreGrowth(startDoc, endDoc, startDocument, endDocument) {
  const startTextLen = textLenOf(startDocument);
  const endTextLen = textLenOf(endDocument);
  const startTagLen = Math.max(0, startDoc.length - startTextLen);
  const endTagLen = Math.max(0, endDoc.length - endTextLen);

  const tagDelta = endTagLen - startTagLen;
  const textDelta = endTextLen - startTextLen;

  if (tagDelta <= 0) {
    const note = `growth: tag ${tagDelta} chars, text ${textDelta >= 0 ? '+' : ''}${textDelta} chars (markup did not grow)`;
    return { score: 1, note };
  }

  const ratio = tagDelta / (Math.max(0, textDelta) + GROWTH_SMOOTH_CHARS);
  const score = clamp01(1 - Math.max(0, ratio - 1) / (GROWTH_RATIO_CEILING - 1));
  const note = `growth: tag +${tagDelta} chars, text ${textDelta >= 0 ? '+' : ''}${textDelta} chars, ratio ${ratio.toFixed(2)}`;
  return { score, note };
}

// ─── entry point ────────────────────────────────────────────────────────

/**
 * Score a document's coherence at the end of an edit trajectory, relative to
 * where it started. Model-free, deterministic, pure function of the two
 * document strings — see the file header for exactly what each dimension can
 * and cannot detect.
 *
 * @param {string} startDoc — the document body before the edit sequence
 * @param {string} endDoc — the document body after the edit sequence
 * @returns {{ dimensions: Record<typeof DIMENSIONS[number], number>, notes: string[] }}
 */
export function scoreCoherence(startDoc, endDoc) {
  const startDocument = domOf(startDoc);
  const endDocument = domOf(endDoc);

  const headings = scoreHeadings(endDocument);
  const classChurn = scoreClassChurn(startDocument, endDocument);
  const deadStyles = scoreDeadStyles(endDocument);
  const idHygiene = scoreIdHygiene(endDocument);
  const growth = scoreGrowth(startDoc, endDoc, startDocument, endDocument);

  return {
    dimensions: {
      headings: headings.score,
      classChurn: classChurn.score,
      deadStyles: deadStyles.score,
      idHygiene: idHygiene.score,
      growth: growth.score,
    },
    notes: [headings.note, classChurn.note, deadStyles.note, idHygiene.note, growth.note],
  };
}
