// FAIL-03 — three consecutive failures; on retry exhaustion, the
// user-visible error includes the helper context.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';

const FIXTURE = `<article><p>EDIT_ME Initial.</p></article>`;

export default {
  id: 'FAIL-03',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'three consecutive failures; doc unchanged, no commit, no silent escalation',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Three consecutive bad edits — exhaust retry budget.',
  stub: () => stubModel([
    // Turn 1: find_not_found
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'NONEXISTENT_1', replace: 'x' }] } },
    // Turn 2: another find_not_found
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'NONEXISTENT_2', replace: 'x' }] } },
    // Turn 3: yet another
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'NONEXISTENT_3', replace: 'x' }] } },
  ]),
  success: async (doc, fixture) => runSelectorOracle('<div></div>', [
    { fn: () => doc === fixture, label: 'doc unchanged after retry exhaustion' },
  ]),
  stability: (fixture, doc, envelope) => {
    if (envelope) return { drift_bytes: fixture.length, drift_ratio: 1, score: 0, reason: 'unexpected envelope after retry exhaustion' };
    return { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'no commit after 3 failures (clean exhaustion)' };
  },
};
