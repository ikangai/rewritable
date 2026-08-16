// Multi-dimension import-fidelity scorer — increment 2 of
// docs/plans/2026-08-16-import-fidelity-benchmark-design.md.
//
// Reuses cli/src/import-fidelity.mjs's `structuralScore` for two of the five
// dimensions (coverage, garble) rather than reimplementing them — that
// scorer's own header is candid that it is a FLOOR: coverage uses substring
// `includes` (order-blind) and garble only counts U+FFFD + control chars.
// This module adds the three dimensions that repair those documented
// blind spots and turn today's silent semantic losses into numbers:
//
//   - order     NEW. Longest-increasing-subsequence over each expected
//               phrase's position in the output text. A reordered doc keeps
//               coverage≈1 but must drop order — this is the reason this
//               scorer exists (design doc "Five scored dimensions").
//   - structure NEW. Closeness of found headings/tables(shape)/lists to the
//               manifest's ground-truth counts, weighted only by the
//               structural aspects the SOURCE actually has (a plain-text
//               source isn't diluted by structure it never claimed to have).
//   - special   NEW. Whether required SVG/MathML content survived the
//               import — pins the silent `sanitizeImportedHtml` strip.
//
// See benchmark/fixtures/import/README.md for the manifest schema this
// scorer reads, and docs/plans/2026-08-16-import-fidelity-benchmark-design.md
// for the full rationale. Benchmark-only: nothing here ships in the CLI.

import jsdomPkg from 'jsdom';
const { JSDOM } = jsdomPkg;
import { structuralScore } from '../../cli/src/import-fidelity.mjs';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;

// Unicode private-use-area ranges — a common CMap-failure signature: a PDF
// with a broken/incomplete font encoding can map glyphs into these ranges
// instead of emitting U+FFFD, which structuralScore's badChars() (U+FFFD +
// control only) does not see at all. Iterate with for..of so a supplementary-
// plane PUA char (surrogate pair) is tested as one code point, not two.
function isPua(cp) {
  return (cp >= 0xE000 && cp <= 0xF8FF) ||
    (cp >= 0xF0000 && cp <= 0xFFFFD) ||
    (cp >= 0x100000 && cp <= 0x10FFFD);
}

function puaShare(text) {
  let count = 0;
  for (const ch of text) {
    if (isPua(ch.codePointAt(0))) count++;
  }
  return count / Math.max(1, text.length);
}

// Longest strictly-increasing subsequence length. O(n^2) — n is the phrase
// count per fixture (a handful), so the simple DP is plenty.
function lisLength(arr) {
  const n = arr.length;
  if (n === 0) return 0;
  const dp = new Array(n).fill(1);
  let best = 1;
  for (let i = 1; i < n; i++) {
    for (let j = 0; j < i; j++) {
      if (arr[j] < arr[i] && dp[j] + 1 > dp[i]) dp[i] = dp[j] + 1;
    }
    if (dp[i] > best) best = dp[i];
  }
  return best;
}

function scoreOrder(outputText, keyPhrasesInOrder) {
  if (!keyPhrasesInOrder.length) return 1;
  const positions = keyPhrasesInOrder
    .map((p) => outputText.indexOf(p))
    .filter((p) => p !== -1);
  return lisLength(positions) / keyPhrasesInOrder.length;
}

// e<=0 means "nothing expected" — trivially close (1). Otherwise a linear
// falloff capped at 0, so a found count arbitrarily far from expected floors
// at 0 rather than going negative.
function countCloseness(f, e) {
  if (e <= 0) return 1;
  return Math.max(0, 1 - Math.abs(f - e) / e);
}

// expected===0 tables → nothing to preserve (1). found===0 but expected>0 →
// total loss (0, the documented span-soup PDF gap). Otherwise: how close the
// table COUNT is, times how close each found/expected pair's SHAPE is
// (index-paired — this corpus has at most one table per fixture, so pairing
// by position is sufficient; a corpus with multiple same-shaped tables would
// need real matching, deferred).
function tableCloseness(found, expected) {
  if (expected.length === 0) return 1;
  if (found.length === 0) return 0;
  const n = Math.min(found.length, expected.length);
  let shapeSum = 0;
  for (let i = 0; i < n; i++) {
    shapeSum += (countCloseness(found[i].rows, expected[i].rows) +
      countCloseness(found[i].cols, expected[i].cols)) / 2;
  }
  return countCloseness(found.length, expected.length) * (shapeSum / n);
}

function scoreStructure(facts, manifest) {
  const foundHeadings = facts.headingLevels.length;
  const foundTables = facts.tables;
  const foundLists = facts.lists;
  // `|| []` / `|| 0` defaults: a manifest that only asserts phrases (no
  // structural claims) should not crash structure scoring.
  const eH = (manifest.headings || []).length;
  const eT = manifest.tables || [];
  const eL = manifest.lists || 0;

  const aspects = [];
  if (eH > 0) aspects.push(countCloseness(foundHeadings, eH));
  if (eT.length > 0) aspects.push(tableCloseness(foundTables, eT));
  if (eL > 0) aspects.push(countCloseness(foundLists, eL));

  if (aspects.length) return mean(aspects);
  // The source has NO structural elements to preserve — nothing to lose, so
  // structure=1. Note this is v1's honest scope-down: it does NOT penalize a
  // converter that adds SPURIOUS headings/tables/lists a plain-text source
  // never had. That asymmetry is deliberate (see design doc) — flag if it
  // ever needs closing.
  return 1;
}

function scoreSpecial(facts, manifest) {
  const reqs = [];
  if (manifest.expectSvg) reqs.push(facts.hasSvg ? 1 : 0);
  if (manifest.expectMath) reqs.push(facts.hasMath ? 1 : 0);
  return reqs.length ? mean(reqs) : 1;
}

/**
 * Extract structural facts from converter output HTML via jsdom.
 * @param {string} outputHtml
 * @returns {{headingLevels:number[], tables:{rows:number,cols:number}[], lists:number, hasSvg:boolean, hasMath:boolean, text:string}}
 */
export function extractFacts(outputHtml) {
  const dom = new JSDOM('<!DOCTYPE html><html><body>' + outputHtml + '</body></html>');
  const document = dom.window.document;

  const headingLevels = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    .map((el) => +el.tagName[1]);

  const tables = [...document.querySelectorAll('table')].map((t) => {
    const trs = [...t.querySelectorAll('tr')];
    return {
      rows: trs.length,
      cols: Math.max(0, ...trs.map((r) => r.querySelectorAll('td,th').length)),
    };
  });

  const lists = document.querySelectorAll('ul,ol').length;
  const hasSvg = /<svg[\s>]/i.test(outputHtml);
  const hasMath = /<math[\s>]/i.test(outputHtml);
  const text = document.body.textContent.replace(/\s+/g, ' ').trim();

  return { headingLevels, tables, lists, hasSvg, hasMath, text };
}

/**
 * Score converter output against a fixture manifest on five [0,1] dimensions.
 * Parses outputHtml exactly once (inside extractFacts) and reuses the result
 * for coverage/order/garble too.
 * @param {string} outputHtml
 * @param {object} manifest — see benchmark/fixtures/import/README.md
 * @returns {{coverage:number, order:number, garble:number, structure:number, special:number, facts:object}}
 */
export function scoreImport(outputHtml, manifest) {
  const facts = extractFacts(outputHtml);
  const outputText = facts.text;
  const expectedText = manifest.keyPhrasesInOrder.join('  ');

  // coverage — reuse the shipped scorer: does the OUTPUT contain every
  // expected phrase's tokens, order-blind.
  const coverage = structuralScore({ sourceText: expectedText }, outputHtml).coverage;

  // garble — reuse the shipped scorer's U+FFFD/control measure on the OUTPUT
  // text, then broaden it: subtract the PUA share so a CMap failure that
  // lands glyphs in the PUA (invisible to badChars()) also drags this down.
  const base = structuralScore({ sourceText: outputText }, outputHtml).garble;
  const garble = clamp01(base - puaShare(outputText));

  // order — the dimension this scorer exists for (see file header).
  const order = scoreOrder(outputText, manifest.keyPhrasesInOrder);

  const structure = scoreStructure(facts, manifest);
  const special = scoreSpecial(facts, manifest);

  return { coverage, order, garble, structure, special, facts };
}
