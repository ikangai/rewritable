// INTERACT-05 — wizard, 5 steps, currently on step 3 (state in
// localStorage); after edit, doc remains on step 3.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="wizard"></div>
<script>
(function() {
  const step = parseInt(localStorage.getItem('rwa_wizard_step') || '1', 10);
  document.getElementById('wizard').textContent = 'step ' + step + ' of 5';
})();
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-05',
  category: 'INTERACT',
  description: 'wizard step in localStorage persists across edit',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    ctx.window.localStorage.setItem('rwa_wizard_step', '3');
    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));
    return { wizard: ctx.window.document.getElementById('wizard')?.textContent };
  },
  scoreAfterCustom: (out) => {
    const ok = (out.wizard || '').includes('step 3 of 5');
    return {
      successResult: { score: ok ? 2 : 0, total: 1, passed: ok ? 1 : 0, results: [{ ok, label: `wizard=${out.wizard}` }] },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
