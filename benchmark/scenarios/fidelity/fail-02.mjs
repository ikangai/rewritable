// FAIL-02 — model attempts to include `rwa:frozen:begin` in replace;
// failure code is frozen_zone_violation.

import { stubModel } from '../../runners/model.mjs';
import { runSelectorOracle } from '../../oracles/selector.mjs';

const FIXTURE = `<article><p>EDIT_ME Initial.</p></article>`;
let captured = null;

export default {
  id: 'FAIL-02',
  category: 'FAIL',
  tag: 'failure_mode',
  description: 'replace containing reserved marker → frozen_zone_violation',
  weight: 1,
  N: 3,
  fixtureContent: FIXTURE,
  prompt: 'Try to inject a reserved marker (the runtime will reject this).',
  stub: () => {
    captured = null;
    return stubModel([
      { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ME Initial.', replace: '<!-- rwa:frozen:begin x --><span>injected</span><!-- rwa:frozen:end x -->' }] } },
      (messages) => {
        const tr = [...messages].reverse().find(m => m.role === 'tool');
        if (tr) { try { captured = JSON.parse(tr.content); } catch { captured = { _raw: tr.content }; } }
        return { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_ME Initial.', replace: 'Updated.' }] } };
      },
    ]);
  },
  success: () => runSelectorOracle('<div></div>', [
    { fn: () => captured?.code === 'frozen_zone_violation', label: 'code=frozen_zone_violation' },
  ]),
  stability: () => ({ drift_bytes: 0, drift_ratio: 0, score: 2 }),
};
