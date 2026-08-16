// Self-test for the import-facts scorer. Run via `node oracles/import-facts.test.mjs`.
// Rule 9 — each check pins WHY a dimension exists, not just what it returns:
// every check here is a case where the OLD shipped scorer (min(coverage,
// garble)) would score ~1 and miss a real fidelity loss. Synthetic HTML only
// — no converters are run here (that's the runner, increment 3).

import { scoreImport } from './import-facts.mjs';

let pass = 0, fail = 0;
const t = (label, ok, detail) => { if (ok) pass++; else { fail++; console.error(`FAIL: ${label}${detail ? ' — ' + detail : ''}`); } };

// 1. order kills structuralScore's reorder-blindness — THE pin this scorer
// exists for: all three phrases are present (coverage stays high) but
// reversed, so order must drop hard.
{
  const manifest = { keyPhrasesInOrder: ['Alpha', 'Bravo', 'Charlie'] };
  const r = scoreImport('<p>Charlie Bravo Alpha</p>', manifest);
  t('reordered text: coverage>0.9 && order<0.6', r.coverage > 0.9 && r.order < 0.6,
    `coverage=${r.coverage} order=${r.order}`);
}

// 2. coverage still catches an outright dropped phrase.
{
  const manifest = { keyPhrasesInOrder: ['Alpha', 'Bravo', 'Charlie'] };
  const r = scoreImport('<p>Alpha Bravo</p>', manifest);
  t('dropped phrase: coverage < 1', r.coverage < 1, `coverage=${r.coverage}`);
}

// 3. structure drops when the source's table is lost (the documented
// span-soup PDF gap), and recovers when a matching table is present.
{
  const manifest = { headings: [], tables: [{ rows: 3, cols: 3 }], lists: 0, keyPhrasesInOrder: ['x'] };

  const noTable = scoreImport('<p>x</p>', manifest);
  t('table lost: structure < 0.1', noTable.structure < 0.1, `structure=${noTable.structure}`);

  const withTable = scoreImport(
    '<p>x</p><table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    manifest,
  );
  t('table matches (3x3): structure > 0.9', withTable.structure > 0.9, `structure=${withTable.structure}`);
}

// 4. special pins the silent SVG/MathML drop (sanitizeImportedHtml strips
// both from MD/clone imports today with only a generic warning).
{
  const manifest = { expectSvg: true, expectMath: true, headings: [], tables: [], lists: 0, keyPhrasesInOrder: ['x'] };

  const stripped = scoreImport('<p>x</p>', manifest);
  t('svg+math stripped: special === 0', stripped.special === 0, `special=${stripped.special}`);

  const kept = scoreImport('<p>x</p><svg></svg><math></math>', manifest);
  t('svg+math present: special === 1', kept.special === 1, `special=${kept.special}`);
}

// 5. garble drops on U+FFFD (shipped signal) AND on private-use-area chars
// (the broadening this scorer adds — a CMap failure that lands glyphs in the
// PUA is invisible to structuralScore's badChars(), which only counts
// U+FFFD + control chars).
{
  const manifest = { keyPhrasesInOrder: ['x'], headings: [], tables: [], lists: 0 };

  const withReplacement = scoreImport('<p>' + 'x'.repeat(5) + '�'.repeat(10) + '</p>', manifest);
  t('U+FFFD garble: garble < 1', withReplacement.garble < 1, `garble=${withReplacement.garble}`);

  const withPua = scoreImport('<p>' + 'x'.repeat(5) + String.fromCodePoint(0xE000).repeat(10) + '</p>', manifest);
  t('PUA garble (broadening pins the CMap gap): garble < 1', withPua.garble < 1, `garble=${withPua.garble}`);
}

// 6. a faithful import — phrases present in order, matching table, svg and
// math both present — scores > 0.9 on every dimension at once.
{
  const manifest = {
    keyPhrasesInOrder: ['Alpha', 'Bravo', 'Charlie'],
    headings: [{ level: 1, text: 'Alpha' }],
    tables: [{ rows: 2, cols: 2 }],
    lists: 1,
    expectSvg: true,
    expectMath: true,
  };
  const html = `
    <h1>Alpha</h1>
    <p>Bravo comes next, then Charlie at the end.</p>
    <table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>
    <ul><li>item</li></ul>
    <svg></svg>
    <math></math>
  `;
  const r = scoreImport(html, manifest);
  t(
    'faithful import: all five dims > 0.9',
    r.coverage > 0.9 && r.order > 0.9 && r.garble > 0.9 && r.structure > 0.9 && r.special > 0.9,
    `coverage=${r.coverage} order=${r.order} garble=${r.garble} structure=${r.structure} special=${r.special}`,
  );
}

console.log(`oracles/import-facts.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
