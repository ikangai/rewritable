// APP-05 — event listeners on elements inside #rwa-doc-mount rebind via
// renderDoc's script-replacement dance. Click after edit fires the
// re-attached handler.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<button id="btn">click me</button>
<div id="out">unset</div>
<script>
document.getElementById('btn').addEventListener('click', () => {
  document.getElementById('out').textContent = 'CLICKED';
});
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-05',
  category: 'APP',
  tag: 'content',
  description: 'event listener rebinds via renderDoc script-replacement; post-edit click fires',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');

    await new Promise(r => setTimeout(r, 50));
    const btn = ctx.window.document.getElementById('btn');
    if (btn) btn.click();
    await new Promise(r => setTimeout(r, 20));
    return { out: ctx.window.document.getElementById('out')?.textContent };
  },
  scoreAfterCustom: (out) => ({
    successResult: {
      score: out.out === 'CLICKED' ? 2 : 0, total: 1, passed: out.out === 'CLICKED' ? 1 : 0,
      results: [{ ok: out.out === 'CLICKED', label: `out=${out.out}` }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
