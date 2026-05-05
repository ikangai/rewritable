// FAIL-09 — mixed-failure retry: turn 1 find_not_unique, turn 2
// frozen_zone_violation, turn 3 succeeds. Runtime feeds back distinct
// failure types and final envelope succeeds.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';
import { computeDriftFromEdits, regionOfLiteral, discretizeStability } from '../../oracles/diff.mjs';

const FIXTURE = `<article>
<p>FIRST_ANCHOR alpha.</p>
<ul>
<li>Buy bread</li>
<li>Buy bread</li>
</ul>
</article>`;

export default {
  id: 'FAIL-09',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'mixed-failure retry: find_not_unique → frozen_zone_violation → success',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Three turns: find_not_unique, then frozen marker, then success.',
  stub: () => stubModel([
    // Turn 1: find_not_unique
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: '<li>Buy bread</li>', replace: '' }] } },
    // Turn 2: frozen_zone_violation (replace contains a marker)
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'FIRST_ANCHOR alpha.', replace: '<!-- rwa:frozen:begin x -->bad<!-- rwa:frozen:end x -->' }] } },
    // Turn 3: clean success
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'FIRST_ANCHOR alpha.', replace: 'Updated alpha.' }] } },
  ]),
  success: (doc) => runSelectorOracle(doc, [
    { fn: (d) => d.body.textContent.includes('Updated alpha.'), label: 'final edit landed on turn 3' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (!envelope?.edits) return { drift_bytes: -1, drift_ratio: 1, score: 0 };
    const region = regionOfLiteral(fixture, 'FIRST_ANCHOR alpha.');
    const d = computeDriftFromEdits(fixture, envelope.edits, [region]);
    return { ...d, score: discretizeStability(d.drift_ratio) };
  },
};
