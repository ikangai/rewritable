// APP-06 — inline <script> with side effects on load (creates a global,
// mutates DOM); edit; script re-runs cleanly without leaving stale state.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div id="loaded-flag">unset</div>
<script>
window.__app_load_count = (window.__app_load_count || 0) + 1;
document.getElementById('loaded-flag').textContent = 'loaded-' + window.__app_load_count;
</script>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'APP-06',
  category: 'APP',
  description: 'inline <script> with load-time side effects re-runs on renderDoc',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    // Wait for initial load.
    await new Promise(r => setTimeout(r, 50));
    const before = ctx.window.document.getElementById('loaded-flag')?.textContent;
    const beforeCount = ctx.window.__app_load_count;

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));

    const after = ctx.window.document.getElementById('loaded-flag')?.textContent;
    const afterCount = ctx.window.__app_load_count;
    return { before, beforeCount, after, afterCount };
  },
  scoreAfterCustom: (out) => {
    const ran = out.afterCount > out.beforeCount;
    return {
      successResult: {
        score: ran ? 2 : 0, total: 1, passed: ran ? 1 : 0,
        results: [{ ok: ran, label: `script load count ${out.beforeCount} → ${out.afterCount}` }],
      },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
    };
  },
};
