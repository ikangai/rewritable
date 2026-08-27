// APP-02 — <details open> persists across unrelated edit.
// EXPECTED-FAIL on current runtime (same root cause as APP-01).

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<details id="more-info">
<summary>Toggle</summary>
<p>Hidden by default.</p>
</details>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-02',
  // scoreAfterCustom returns a HARDCODED stabilityResult (score: 2) — this scenario
  // asserts runtime behaviour (form-state preservation), not document bytes.
  driftProbe: 'none',
  category: 'APP',
  tag: 'content',
  description: '<details open> state persists across edit (EXPECTED-FAIL on current runtime)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    const det = ctx.window.document.getElementById('more-info');
    if (det) det.open = true;

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');

    const detAfter = ctx.window.document.getElementById('more-info');
    return { stillOpen: detAfter?.hasAttribute('open') || detAfter?.open === true };
  },
  scoreAfterCustom: (out) => ({
    successResult: {
      score: out.stillOpen ? 2 : 0, total: 1, passed: out.stillOpen ? 1 : 0,
      results: [{ ok: out.stillOpen, label: out.stillOpen ? 'details open preserved' : '<details open> reset (runtime gap)' }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
