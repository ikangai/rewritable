// INTERACT-02 — Ctrl+B keyboard shortcut for "bold" in the doc's script;
// after edit, shortcut still binds and works.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="status">unset</div>
<script>
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
    document.getElementById('status').textContent = 'BOLD';
  }
});
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-02',
  category: 'INTERACT',
  tag: 'content',
  description: 'Ctrl+B keyboard shortcut still fires after edit (script re-attached listener)',
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

    const ev = new ctx.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true });
    ctx.window.document.dispatchEvent(ev);
    await new Promise(r => setTimeout(r, 20));
    return { status: ctx.window.document.getElementById('status')?.textContent };
  },
  scoreAfterCustom: (out) => ({
    successResult: { score: out.status === 'BOLD' ? 2 : 0, total: 1, passed: out.status === 'BOLD' ? 1 : 0, results: [{ ok: out.status === 'BOLD', label: `status=${out.status}` }] },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
