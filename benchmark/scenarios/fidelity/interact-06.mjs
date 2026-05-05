// INTERACT-06 — wizard with module-scope state (negative variant of -05);
// state resets to step 1 after edit. Spec: documented + observable
// indication.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="wizard">unset</div>
<script>
(function() {
  let step = 1;
  function render() { document.getElementById('wizard').textContent = 'step ' + step + ' of 5'; }
  window.__advanceWizard = function() { step++; render(); };
  render();
})();
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-06',
  category: 'INTERACT',
  tag: 'content',
  description: 'module-scope wizard state resets to step 1 across edit (expected per spec)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    if (typeof ctx.window.__advanceWizard === 'function') {
      ctx.window.__advanceWizard();
      ctx.window.__advanceWizard();
    }
    const before = ctx.window.document.getElementById('wizard')?.textContent;

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));
    return { before, after: ctx.window.document.getElementById('wizard')?.textContent };
  },
  scoreAfterCustom: (out) => {
    const ok = out.before === 'step 3 of 5' && out.after === 'step 1 of 5';
    return {
      successResult: { score: ok ? 2 : 0, total: 1, passed: ok ? 1 : 0, results: [{ ok, label: `before=${out.before} after=${out.after}` }] },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
