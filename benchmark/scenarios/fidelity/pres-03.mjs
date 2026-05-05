// PRES-03 — heading hierarchy preserved across an edit. H1/H2/H3 nesting
// unchanged when only prose under H3 is edited.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<h1>Top</h1>
<h2>Sub</h2>
<h3>SubSub</h3>
<p>H3_PROSE Initial prose under H3.</p>
<h2>Sub two</h2>
<p>Sub two prose untouched.</p>
</article>`;

export default {
  id: 'PRES-03',
  category: 'PRES',
  tag: 'content',
  description: 'edit H3 prose only; H1/H2/H3 hierarchy unchanged',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Rewrite the prose paragraph immediately under the H3. Don\'t touch the heading structure.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'H3_PROSE Initial prose under H3.', replace: 'Updated H3 prose.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('h1').length === 1, label: 'one h1' },
    { fn: (d) => d.querySelectorAll('h2').length === 2, label: 'two h2s' },
    { fn: (d) => d.querySelectorAll('h3').length === 1, label: 'one h3' },
    { fn: (d) => Array.from(d.querySelectorAll('h1, h2, h3')).map(h => h.tagName).join(',') === 'H1,H2,H3,H2', label: 'order preserved' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'H3_PROSE Initial prose under H3.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
