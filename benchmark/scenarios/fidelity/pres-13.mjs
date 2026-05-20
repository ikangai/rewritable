// PRES-13 — @media print block with break-control, orphans, widows, and
// print-color-adjust rules. Edit body prose; the entire @media print rule
// stays byte-identical. Print-time invariants are the load-bearing case
// for "what you see on screen matches what you get on paper" — losing
// these silently is one of the worst editing failure modes.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const PRINT_RULES = `@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1, h2, h3 { break-after: avoid; page-break-after: avoid; }
  figure, pre, blockquote, table { break-inside: avoid; page-break-inside: avoid; }
  tr, li { break-inside: avoid; page-break-inside: avoid; }
  p { orphans: 3; widows: 3; }
  a { color: #000 !important; text-decoration: underline; }
  .no-print { display: none !important; }
}`;

const FIXTURE = `<style>
@page { size: A4; margin: 18mm; }
${PRINT_RULES}
</style>
<article>
<h1>Annual review</h1>
<p>PROSE_ANCHOR The opening paragraph summarizing fiscal-year highlights.</p>
<figure><img src="chart.svg" alt="Revenue chart"><figcaption>Revenue by quarter</figcaption></figure>
<p>A second paragraph drawing conclusions from the chart above.</p>
<p class="no-print">Internal note: this section will not be printed.</p>
</article>`;

export default {
  id: 'PRES-13',
  category: 'PRES',
  tag: 'content',
  description: 'edit body prose; @media print rules (break/orphans/widows/color-adjust) byte-identical',
  weight: 2,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the opening paragraph (the one starting with "PROSE_ANCHOR") to read: "Fiscal year 2026 closed 14% above plan, driven by mid-year hosting expansion.". Leave the <style> block alone — the @page rule and the @media print block stay byte-identical.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'PROSE_ANCHOR The opening paragraph summarizing fiscal-year highlights.',
        replace: 'Fiscal year 2026 closed 14% above plan, driven by mid-year hosting expansion.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page'), label: '@page rule retained' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('@media print'), label: '@media print retained' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('print-color-adjust: exact'), label: 'print-color-adjust preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('break-after: avoid'), label: 'break-after avoid rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('break-inside: avoid'), label: 'break-inside avoid rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('orphans: 3'), label: 'orphans rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('widows: 3'), label: 'widows rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('.no-print'), label: '.no-print rule preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.includes('Fiscal year 2026 closed 14%')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('PROSE_ANCHOR'), label: 'anchor token removed' },
    { fn: (d) => d.querySelector('article figure figcaption')?.textContent === 'Revenue by quarter', label: 'figure + figcaption untouched' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'PROSE_ANCHOR The opening paragraph summarizing fiscal-year highlights.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
