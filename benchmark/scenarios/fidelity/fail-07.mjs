// FAIL-07 — happy path of the multi-turn loop: turn 1 returns
// find_not_unique, turn 2 emits a corrected envelope, success on round 2.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<ul>
<li>Buy bread</li>
<li>Buy bread</li>
</ul>
</article>`;

export default {
  id: 'FAIL-07',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'turn 1 ambiguous → turn 2 disambiguated → success; happy path of multi-turn',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Remove a "Buy bread" item.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<li>Buy bread</li>', replace: '' }] } },
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<li>Buy bread</li>\n<li>Buy bread</li>', replace: '<li>Buy bread</li>' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.querySelectorAll('li').length === 1, label: '1 item remains' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, '<li>Buy bread</li>\n<li>Buy bread</li>');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
