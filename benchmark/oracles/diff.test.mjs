// Self-test for the diff oracle. Run via `node oracles/diff.test.mjs`.
// Returns 0 (and prints a single-line summary) on success; non-zero on any
// failure. Integration into run-conformance.mjs is deferred — for now this
// is a quick sanity gate when developing the oracle.

import { diffSingleHunk, computeDrift, computeDriftFromEdits, discretizeStability, regionOfLiteral } from './diff.mjs';

let pass = 0, fail = 0;
const t = (label, ok, detail) => { if (ok) { pass++; } else { fail++; console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`); } };

// 1. Identical strings → no drift
{
  const r = diffSingleHunk('Hello, world.', 'Hello, world.');
  t('identical → drift=0', r.drift_bytes === 0);
}

// 2. Single character flip → drift=1
{
  const r = diffSingleHunk('thier', 'their');
  t('thier→their flip → drift=2', r.drift_bytes === 2, `got ${r.drift_bytes}`);
  // thier=t-h-i-e-r, their=t-h-e-i-r. Common prefix "th" (2), common suffix "r" (1).
  // Differing region is "ie"/"ei" → hunkA = [2, 4].
  t('hunkA = [2,4]', r.hunkA[0] === 2 && r.hunkA[1] === 4, JSON.stringify(r.hunkA));
}

// 3. CRLF normalization
{
  const r = diffSingleHunk('a\r\nb', 'a\nb');
  t('CRLF vs LF → drift=0 after canon', r.drift_bytes === 0);
}

// 4. computeDrift inside expected region → drift_bytes=0
{
  const fixture = '<p>line1</p>\n<p>thier typo</p>\n<p>line3</p>';
  const result = '<p>line1</p>\n<p>their typo</p>\n<p>line3</p>';
  const region = regionOfLiteral(fixture, 'thier typo');
  t('regionOfLiteral finds substring', region !== null);
  const d = computeDrift(fixture, result, [region]);
  t('inRegion edit → drift_bytes=0', d.drift_bytes === 0, JSON.stringify(d));
  t('inRegion edit → drift_ratio=0', d.drift_ratio === 0);
}

// 5. computeDrift outside expected region → drift_bytes>0
{
  const fixture = '<p>line1</p>\n<p>line2</p>\n<p>line3</p>';
  const result = '<p>LINE_ONE</p>\n<p>line2</p>\n<p>line3</p>';
  const allowedRegion = regionOfLiteral(fixture, 'line2');
  const d = computeDrift(fixture, result, [allowedRegion]);
  t('out-of-region edit → drift_bytes > 0', d.drift_bytes > 0, JSON.stringify(d));
}

// 6. Discretize stability per spec §2.2
{
  t('drift_ratio=0 → T=2', discretizeStability(0) === 2);
  t('drift_ratio=0.005 → T=1', discretizeStability(0.005) === 1);
  t('drift_ratio=0.02 → T=0', discretizeStability(0.02) === 0);
}

// 7. computeDriftFromEdits measures the EFFECTIVE changed core, not the full
//    anchor. WHY this matters: the system prompt tells the model to widen
//    anchors with surrounding context for uniqueness. Those shared affixes are
//    spliced back byte-identical, so they are NOT a side effect — scoring them
//    as drift made every real-model edit that padded an anchor look unstable.
{
  // 7a. Minimal anchor whose change lands in-region → no drift (baseline parity
  //     with the old behaviour).
  const fixture = '<article>\n<h2 id="heading-3">HEADING_TEXT Original title</h2>\n<section aria-labelledby="heading-3"><p>Section content.</p></section>\n</article>';
  const region = regionOfLiteral(fixture, 'HEADING_TEXT Original title');
  const minimal = computeDriftFromEdits(fixture, [{ find: 'HEADING_TEXT Original title', replace: 'Updated title' }], [region]);
  t('minimal anchor in-region → drift=0', minimal.drift_bytes === 0, JSON.stringify(minimal));

  // 7b. PADDED anchor — the exact ID-02 real-model envelope. find/replace share
  //     the prefix ">" and the suffix " title</h2>"; the effective change is
  //     only "HEADING_TEXT Original" → "Updated", which sits inside the region.
  //     The old code scored the whole ">..</h2>" span as drift (T=0); the fix
  //     reports drift=0 because no byte outside the region actually changed.
  const padded = computeDriftFromEdits(fixture, [{ find: '>HEADING_TEXT Original title</h2>', replace: '>Updated title</h2>' }], [region]);
  t('padded anchor, change in-region → drift=0 (was the ID-02 false positive)', padded.drift_bytes === 0, JSON.stringify(padded));

  // 7c. SAFETY: a padded anchor that ALSO changes bytes outside the region must
  //     still be caught. Here the model edits both the in-region word and an
  //     out-of-region sibling under one padded anchor — the effective core
  //     widens to span both, so drift must be > 0. (Guards against the fix
  //     masking real side effects.)
  const fx2 = '<p id="a">foo</p>\n<p id="b">bar</p>';
  const r2 = regionOfLiteral(fx2, 'foo');
  const comod = computeDriftFromEdits(fx2, [{ find: '<p id="a">foo</p>\n<p id="b">bar</p>', replace: '<p id="a">FIX</p>\n<p id="b">CHANGED</p>' }], [r2]);
  t('co-modification under padded anchor → drift>0 (still caught)', comod.drift_bytes > 0, JSON.stringify(comod));

  // 7d. Pure insertion (find is a prefix of replace) → zero-width core at the
  //     insertion point, which sits at the boundary of the anchored region → no
  //     drift. This is the CONT-01/FID-06 "add an item after X" shape.
  const fx3 = '<ul>\n<li>one</li>\n<li>two</li>\n</ul>';
  const r3 = regionOfLiteral(fx3, '<li>two</li>\n');
  const ins = computeDriftFromEdits(fx3, [{ find: '<li>two</li>\n', replace: '<li>two</li>\n<li>three</li>\n' }], [r3]);
  t('pure insertion at region boundary → drift=0', ins.drift_bytes === 0, JSON.stringify(ins));

  // 7e. Genuinely out-of-region edit (no shared affix with the region) → drift>0.
  const fx4 = '<p>line1</p>\n<p>line2</p>\n<p>line3</p>';
  const r4 = regionOfLiteral(fx4, 'line2');
  const out = computeDriftFromEdits(fx4, [{ find: 'line1', replace: 'LINE_ONE' }], [r4]);
  t('edit outside the only allowed region → drift>0', out.drift_bytes > 0, JSON.stringify(out));

  // 7f. find absent from fixture → span null, not counted as drift (degenerate
  //     SEQ-pattern case, surfaced rather than silently charged).
  const miss = computeDriftFromEdits(fx4, [{ find: 'not-present-anywhere', replace: 'x' }], [r4]);
  t('absent find → span null, drift=0', miss.drift_bytes === 0 && miss.spans[0] === null, JSON.stringify(miss));
}

console.log(`oracles/diff.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
