// APP-04 — counter in module-scope JS only; trigger edit; counter resets.
//
// Per spec: this is the "expected fail" — module-scope state cannot
// persist across renderDoc's script-replacement. The test verifies the
// behavior is documented (in this case, "resets to initial value").
//
// Score 2 if counter resets cleanly. Score 0 if anything weird happens.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="ctr">--</div>
<script>
(function() {
  let count = 0;
  function render() { document.getElementById('ctr').textContent = String(count); }
  window.__appBumpCount = function() { count++; render(); };
  render();
})();
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-04',
  category: 'APP',
  description: 'module-scope counter resets across edit (expected behavior per spec; score 2 on clean reset)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    // Increment via the exposed __appBumpCount function 47 times.
    if (typeof ctx.window.__appBumpCount === 'function') {
      for (let i = 0; i < 47; i++) ctx.window.__appBumpCount();
    }
    const before = ctx.window.document.getElementById('ctr')?.textContent;

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');

    await new Promise(r => setTimeout(r, 50));
    const after = ctx.window.document.getElementById('ctr')?.textContent;
    return { before, after };
  },
  scoreAfterCustom: (out) => {
    const ok = out.before === '47' && out.after === '0';
    return {
      successResult: {
        score: ok ? 2 : 0, total: 1, passed: ok ? 1 : 0,
        results: [{ ok, label: `before=${out.before} after=${out.after} (expected 47 → 0)` }],
      },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
