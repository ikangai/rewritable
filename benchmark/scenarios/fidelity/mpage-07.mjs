// MPAGE-07 — multi-column body layout with `column-count: 2` and a
// heading that spans both columns via `column-span: all`. Edit a body
// paragraph (in one column); column-count, column-gap, column-rule, AND
// the column-span rule on h2 must all stay byte-identical. Models that
// "simplify" CSS may flatten multi-column to single-column.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 22mm 18mm; }
article { column-count: 2; column-gap: 12mm; column-rule: 1px solid #ddd; column-fill: balance; }
article h2 { column-span: all; margin-top: 0; }
article p { break-inside: avoid; }
article figure { break-inside: avoid; column-span: all; margin: 12mm 0; }
</style>
<article>
<h2>Brief notes from the field</h2>
<p>We surveyed twelve sites over the season; conditions varied widely.</p>
<p>FIELD_LEAD The first site, located at the southern edge of the basin, presented unusually dry soil and was atypical of the cohort.</p>
<p>Subsequent sites returned to expected moisture profiles and reinforced the headline findings.</p>
<figure><figcaption>Figure 1. Sites surveyed, plotted on the basin map.</figcaption></figure>
<p>Two sites produced ambiguous results and were re-sampled in the following month.</p>
</article>`;

export default {
  id: 'MPAGE-07',
  category: 'MPAGE',
  tag: 'content',
  description: 'edit body prose; multi-column layout (column-count/gap/rule/fill) + column-span:all on h2/figure byte-identical',
  weight: 3,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the paragraph starting with "FIELD_LEAD" to read: "The first site, at the southern edge of the basin, showed unusually dry soil and was an outlier in the cohort.". Leave the heading, the figure, the other paragraphs, and the entire stylesheet alone.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [
      { find: 'FIELD_LEAD The first site, located at the southern edge of the basin, presented unusually dry soil and was atypical of the cohort.',
        replace: 'The first site, at the southern edge of the basin, showed unusually dry soil and was an outlier in the cohort.' },
    ] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('article { column-count: 2; column-gap: 12mm; column-rule: 1px solid #ddd; column-fill: balance; }'), label: 'article column rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('article h2 { column-span: all; margin-top: 0; }'), label: 'h2 column-span rule byte-identical' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('article p { break-inside: avoid; }'), label: 'p break-inside rule preserved' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('article figure { break-inside: avoid; column-span: all; margin: 12mm 0; }'), label: 'figure column-span rule byte-identical' },
    { fn: (d) => d.querySelector('article h2')?.textContent === 'Brief notes from the field', label: 'heading preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('The first site, at the southern edge of the basin, showed unusually dry soil')), label: 'edit landed' },
    { fn: (d) => !(d.body?.textContent || '').includes('FIELD_LEAD'), label: 'anchor token removed' },
    { fn: (d) => d.querySelectorAll('article p').length === 4, label: '4 paragraphs preserved' },
    { fn: (d) => d.querySelector('article figcaption')?.textContent === 'Figure 1. Sites surveyed, plotted on the basin map.', label: 'figure caption preserved' },
    { fn: (d) => Array.from(d.querySelectorAll('article p')).some(p => p.textContent.startsWith('Two sites produced ambiguous results')), label: 'final paragraph preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'FIELD_LEAD The first site, located at the southern edge of the basin, presented unusually dry soil and was atypical of the cohort.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
