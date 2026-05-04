// CONT-02 — footnotes [1], [2], [3]; insert a new footnote between 1 and 2;
// subsequent numbering correct.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>First [1] second [2] third [3].</p>
<ol class="footnotes">
<li id="fn-1">Note one.</li>
<li id="fn-2">Note two.</li>
<li id="fn-3">Note three.</li>
</ol>
</article>`;

export default {
  id: 'CONT-02',
  category: 'CONT',
  description: 'insert a new footnote between [1] and [2]; subsequent numbering renumbers',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Insert a new footnote between [1] and [2]. Renumber the prose ([1]→[1], new→[2], [2]→[3], [3]→[4]) and add the corresponding <li> in the list.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [
        { find: 'First [1] second [2] third [3].', replace: 'First [1] inserted [2] second [3] third [4].' },
        { find: '<li id="fn-1">Note one.</li>\n<li id="fn-2">Note two.</li>', replace: '<li id="fn-1">Note one.</li>\n<li id="fn-2">Inserted note.</li>\n<li id="fn-3">Note two.</li>' },
        { find: '<li id="fn-3">Note three.</li>', replace: '<li id="fn-4">Note three.</li>' },
      ] },
    },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('ol.footnotes li').length === 4, label: '4 footnotes' },
    { fn: (d) => d.body.textContent.includes('[4]'), label: 'prose mentions [4]' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const r1 = regionOfLiteral(fixture, 'First [1] second [2] third [3].');
    const r2 = regionOfLiteral(fixture, '<li id="fn-1">Note one.</li>\n<li id="fn-2">Note two.</li>');
    const r3 = regionOfLiteral(fixture, '<li id="fn-3">Note three.</li>');
    if (!r1 || !r2 || !r3) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const d = computeDriftFromEdits(fixture, envelope.edits, [r1, r2, r3]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
