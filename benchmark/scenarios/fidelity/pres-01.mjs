// PRES-01 — @page rules + page-break-before on H1; edit prose in section 2;
// print-pagination still breaks at the same H1s. Mechanical proxy: the
// @page CSS region must remain byte-identical and H1 elements must keep
// their page-break-before declaration.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<style>
@page { size: A4; margin: 2cm; }
@page :first { margin-top: 4cm; }
h1 { page-break-before: always; }
.s2 p { color: #444; }
</style>
<article>
<h1>Section 1</h1>
<p>Section 1 body content. Edits here would not affect pagination.</p>
<h1>Section 2</h1>
<p class="s2">SECTION_2_ANCHOR Section 2 prose to be tightened.</p>
<h1>Section 3</h1>
<p>Section 3 body, untouched.</p>
</article>`;

export default {
  id: 'PRES-01',
  category: 'PRES',
  tag: 'content',
  description: 'edit prose in section 2; @page rules + page-break-before survive',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Tighten the prose of the section 2 paragraph. Leave the @page CSS and the page-break-before rule on h1 byte-identical.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'SECTION_2_ANCHOR Section 2 prose to be tightened.', replace: 'Tightened: section 2 prose, paginated by h1.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelector('style')?.textContent.includes('@page'), label: '@page rules present' },
    { fn: (d) => d.querySelector('style')?.textContent.includes('page-break-before: always'), label: 'h1 page-break rule preserved' },
    { selector: 'p.s2', textContains: 'Tightened', label: 'edit landed' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'SECTION_2_ANCHOR Section 2 prose to be tightened.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
