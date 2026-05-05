// APP-01 — form input values persist across an unrelated edit.
//
// EXPECTED-FAIL on the current runtime: renderDoc replaces innerHTML
// without preserving form state. The benchmark documents this gap.
// Spec: "values persist after re-render."

import { stubModel } from '../../runners/model.mjs';

const FIXTURE = `<form>
<input id="user-input" type="text" value="">
</form>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-01',
  category: 'APP',
  tag: 'content',
  description: 'form input.value persists across unrelated edit (EXPECTED-FAIL: runtime\'s renderDoc destroys input state)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit the prose paragraph.',
  stub: () => stubModel([
    { name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } },
  ]),
  customRun: async ({ ctx }) => {
    // Type into the input element BEFORE the edit.
    const inp = ctx.window.document.getElementById('user-input');
    if (inp) inp.value = 'typed-by-user';

    // Hook fetch with the stub manually (customRun is responsible).
    const { stubModel: sm } = await import('../../runners/model.mjs');
    const { modelToFetch } = await import('../../runners/model.mjs');
    const model = sm([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    const { handler } = modelToFetch(model);
    ctx.setFetchHandler(handler);

    await ctx.modify('edit prose');

    const inpAfter = ctx.window.document.getElementById('user-input');
    return { valuePreserved: inpAfter?.value === 'typed-by-user' };
  },
  scoreAfterCustom: (out, fixture, doc) => ({
    successResult: {
      score: out.valuePreserved ? 2 : 0,
      total: 1,
      passed: out.valuePreserved ? 1 : 0,
      results: [{ ok: out.valuePreserved, label: out.valuePreserved ? 'input.value preserved' : 'input.value lost (renderDoc destroys form state — runtime gap)' }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2, reason: 'runtime-behavior test' },
  }),
};
