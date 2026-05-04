// Self-test for the diff oracle. Run via `node oracles/diff.test.mjs`.
// Returns 0 (and prints a single-line summary) on success; non-zero on any
// failure. Integration into run-conformance.mjs is deferred — for now this
// is a quick sanity gate when developing the oracle.

import { diffSingleHunk, computeDrift, discretizeStability, regionOfLiteral } from './diff.mjs';

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

console.log(`oracles/diff.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
