// Self-test for the coherence scorer. Run via `node oracles/coherence.test.mjs`.
// Rule 9 — each block pins WHY a dimension exists: a healthy case must score
// HIGH and a deliberately degraded case must score MEASURABLY lower on that
// SAME dimension. A scorer that returns 1.0 unconditionally passes none of
// these (every "degraded" check below fails against a constant-1 scorer).

import { scoreCoherence, DIMENSIONS } from './coherence.mjs';

let pass = 0, fail = 0;
const t = (label, ok, detail) => { if (ok) pass++; else { fail++; console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`); } };

// 0. DIMENSIONS names the exact keys scoreCoherence returns — the runner and
// baseline both key off this array, so drift here would silently desync them.
{
  const r = scoreCoherence('<p>x</p>', '<p>x</p>');
  const keys = Object.keys(r.dimensions).sort();
  t('DIMENSIONS matches scoreCoherence output keys', JSON.stringify(keys) === JSON.stringify([...DIMENSIONS].sort()),
    `DIMENSIONS=${DIMENSIONS} keys=${keys}`);
}

// 1. headings — healthy outline (h1, h2, h2, h3) scores high; a level jump
// (h1 -> h3) plus a second h1 scores measurably lower.
{
  const healthy = '<h1>Guide</h1><p>intro</p><h2>Setup</h2><p>a</p><h2>Usage</h2><p>b</p><h3>Advanced</h3><p>c</p>';
  const rHealthy = scoreCoherence('<h1>Guide</h1>', healthy);
  t('headings: clean outline scores > 0.9', rHealthy.dimensions.headings > 0.9,
    `headings=${rHealthy.dimensions.headings}`);

  const degraded = '<h1>Guide</h1><p>intro</p><h3>Deep dive</h3><p>a</p><h1>Guide (again)</h1><p>b</p>';
  const rDegraded = scoreCoherence('<h1>Guide</h1>', degraded);
  t('headings: level-jump + duplicate h1 scores measurably lower',
    rDegraded.dimensions.headings < rHealthy.dimensions.headings - 0.3,
    `healthy=${rHealthy.dimensions.headings} degraded=${rDegraded.dimensions.headings}`);
}

// 2. classChurn — reusing a small, stable class vocabulary scores high;
// wrapping the same content in a fresh single-use class on every step (the
// sk-*/skinning-accretion shape) scores measurably lower.
{
  const start = '<section class="card"><p>Pricing</p></section>';
  const healthyEnd = '<section class="card"><p>Pricing</p></section><section class="card"><p>FAQ</p></section>';
  const rHealthy = scoreCoherence(start, healthyEnd);
  t('classChurn: reused class vocabulary scores > 0.9', rHealthy.dimensions.classChurn > 0.9,
    `classChurn=${rHealthy.dimensions.classChurn}`);

  const degradedEnd = '<div class="sk-wrap-1"><div class="sk-wrap-2"><div class="sk-wrap-3">' +
    '<div class="sk-wrap-4"><section class="card"><p>Pricing</p></section></div></div></div></div>';
  const rDegraded = scoreCoherence(start, degradedEnd);
  t('classChurn: repeated single-use wrapper classes score measurably lower',
    rDegraded.dimensions.classChurn < rHealthy.dimensions.classChurn - 0.3,
    `healthy=${rHealthy.dimensions.classChurn} degraded=${rDegraded.dimensions.classChurn}`);
}

// 3. deadStyles — every simple selector matching something scores high;
// leftover selectors targeting removed content (e.g. after a section was
// deleted but its CSS wasn't) score measurably lower.
{
  const healthy = '<style>.card{padding:8px} #hero{color:red} p{margin:0}</style>' +
    '<div class="card" id="hero"><p>x</p></div>';
  const rHealthy = scoreCoherence(healthy, healthy);
  t('deadStyles: every selector matches something scores > 0.9', rHealthy.dimensions.deadStyles > 0.9,
    `deadStyles=${rHealthy.dimensions.deadStyles}`);

  const degraded = '<style>.card{padding:8px} #hero{color:red} p{margin:0} .old-promo{display:none} #removed-banner{top:0} .legacy-badge{border:1px solid}</style>' +
    '<div class="card" id="hero"><p>x</p></div>';
  const rDegraded = scoreCoherence(degraded, degraded);
  t('deadStyles: leftover selectors for removed content score measurably lower',
    rDegraded.dimensions.deadStyles < rHealthy.dimensions.deadStyles - 0.3,
    `healthy=${rHealthy.dimensions.deadStyles} degraded=${rDegraded.dimensions.deadStyles}`);

  // At-rule bodies are walked past, not descended into — a selector that
  // exists ONLY inside @media is neither flagged dead nor counted at all.
  const mediaOnly = '<style>@media (min-width:600px){.only-in-media{color:red}}</style><p>x</p>';
  const rMedia = scoreCoherence(mediaOnly, mediaOnly);
  t('deadStyles: selector nested inside @media is unscored (trivial 1), not falsely flagged dead',
    rMedia.dimensions.deadStyles === 1, `deadStyles=${rMedia.dimensions.deadStyles}`);
}

// 4. idHygiene — unique ids score high; duplicate `id` and duplicate
// `data-rwa-id` values score measurably lower.
{
  const healthy = '<p id="a">x</p><p id="b" data-rwa-id="r1">y</p><p id="c" data-rwa-id="r2">z</p>';
  const rHealthy = scoreCoherence(healthy, healthy);
  t('idHygiene: all-unique ids scores > 0.9', rHealthy.dimensions.idHygiene > 0.9,
    `idHygiene=${rHealthy.dimensions.idHygiene}`);

  const degraded = '<p id="a">x</p><p id="a" data-rwa-id="r1">y</p><p id="c" data-rwa-id="r1">z</p>';
  const rDegraded = scoreCoherence(degraded, degraded);
  t('idHygiene: duplicate id + duplicate data-rwa-id score measurably lower',
    rDegraded.dimensions.idHygiene < rHealthy.dimensions.idHygiene - 0.3,
    `healthy=${rHealthy.dimensions.idHygiene} degraded=${rDegraded.dimensions.idHygiene}`);
}

// 5. growth — text and markup growing together scores high; markup ballooning
// (nested wrapper divs) while visible text stays flat scores measurably lower.
{
  const start = '<p>Alpha</p>';
  const healthyEnd = '<p>Alpha, now with a good deal more explanatory prose describing the feature in depth.</p><p>Bravo: a brand new paragraph with real content.</p>';
  const rHealthy = scoreCoherence(start, healthyEnd);
  t('growth: text and markup grew together scores > 0.9', rHealthy.dimensions.growth > 0.9,
    `growth=${rHealthy.dimensions.growth}`);

  const wrap = (n, inner) => n === 0 ? inner : `<div class="sk-wrap-${n}">${wrap(n - 1, inner)}</div>`;
  const degradedEnd = wrap(12, '<p>Alpha</p>');
  const rDegraded = scoreCoherence(start, degradedEnd);
  t('growth: wrapper accretion with flat text scores measurably lower',
    rDegraded.dimensions.growth < rHealthy.dimensions.growth - 0.3,
    `healthy=${rHealthy.dimensions.growth} degraded=${rDegraded.dimensions.growth}`);
}

// 6. A doc that stayed put (start === end, no edits at all) scores >0.9 on
// every dimension at once — the trivial no-op trajectory must not look sick.
{
  const doc = '<h1>Report</h1><style>.card{padding:8px}</style><p id="p1" class="card">Body text here.</p>';
  const r = scoreCoherence(doc, doc);
  t(
    'no-op trajectory: all five dims > 0.9',
    DIMENSIONS.every((d) => r.dimensions[d] > 0.9),
    JSON.stringify(r.dimensions),
  );
}

console.log(`oracles/coherence.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
