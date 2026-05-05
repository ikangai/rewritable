// ROB-06 — three identical "Buy bread" items; user says "delete the second
// one". Either model disambiguates with surrounding context, or returns
// find_not_unique cleanly. Stub uses surrounding context to land the edit.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<ul>
<li>Buy bread</li>
<li>Buy bread</li>
<li>Buy bread</li>
</ul>
</article>`;

export default {
  id: 'ROB-06',
  category: 'ROB',
  tag: 'structural_regular',
  description: 'delete the second of 3 identical items; model disambiguates via context',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Delete the SECOND "Buy bread" list item. The first and third must remain.',
  stub: () => stubModel([
    {
      name: 'apply_edits',
      envelope: { version: 'rwa-edit/1', edits: [{
        // Disambiguate via context — anchor on adjacent siblings.
        find: '<li>Buy bread</li>\n<li>Buy bread</li>\n<li>Buy bread</li>',
        replace: '<li>Buy bread</li>\n<li>Buy bread</li>',
      }] },
    },
  ]),
  expectedDslPlan: {
    version: 'rwa-edit-dsl/1',
    ops: [{
      op: 'replace',
      find: '<li>Buy bread</li>\n<li>Buy bread</li>\n<li>Buy bread</li>',
      replace: '<li>Buy bread</li>\n<li>Buy bread</li>',
    }],
  },
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('li').length === 2, label: '2 items remain' },
    { fn: (d) => Array.from(d.querySelectorAll('li')).every(li => li.textContent === 'Buy bread'), label: 'remaining items both Buy bread' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '<li>Buy bread</li>\n<li>Buy bread</li>\n<li>Buy bread</li>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
