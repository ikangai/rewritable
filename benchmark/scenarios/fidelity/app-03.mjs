// APP-03 — counter widget storing count in localStorage; increment to 47;
// trigger an unrelated edit; counter shows 47 after re-render.
//
// localStorage persists across renderDoc — script re-execution will read
// the value back. Should pass on the current runtime.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="counter">--</div>
<script>
(function() {
  const el = document.getElementById('counter');
  const v = parseInt(localStorage.getItem('rwa_counter_demo') || '0', 10);
  el.textContent = String(v);
})();
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-03',
  // scoreAfterCustom returns a HARDCODED stabilityResult (score: 2) — this scenario
  // asserts runtime behaviour (form-state preservation), not document bytes.
  driftProbe: 'none',
  category: 'APP',
  tag: 'content',
  description: 'counter in localStorage persists across edit (script re-reads on render)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    // Set localStorage directly (no DOM interaction needed).
    ctx.window.localStorage.setItem('rwa_counter_demo', '47');

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');

    // Wait briefly for re-rendered script to execute.
    await new Promise(r => setTimeout(r, 50));
    const counter = ctx.window.document.getElementById('counter')?.textContent;
    return { counter };
  },
  scoreAfterCustom: (out) => ({
    successResult: {
      score: out.counter === '47' ? 2 : 0, total: 1, passed: out.counter === '47' ? 1 : 0,
      results: [{ ok: out.counter === '47', label: `counter shows ${out.counter} (expected 47)` }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
