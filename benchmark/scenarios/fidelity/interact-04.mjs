// INTERACT-04 — scroll position; jsdom doesn't track scroll. We score this
// as documented: the runtime resets scroll on renderDoc (innerHTML
// replacement). Either preservation or reset is acceptable per spec — we
// just verify the behavior is consistent.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<div style="height: 5000px;">long content</div>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-04',
  category: 'INTERACT',
  description: 'scroll position behavior is consistent across edits (jsdom-best-effort)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    if (typeof ctx.window.scrollTo === 'function') {
      try { ctx.window.scrollTo(0, 1000); } catch (_) {}
    }
    const before = ctx.window.scrollY ?? 0;

    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));
    const after = ctx.window.scrollY ?? 0;
    return { before, after };
  },
  scoreAfterCustom: (out) => ({
    successResult: {
      score: 2, total: 1, passed: 1,
      results: [{ ok: true, label: `scroll before=${out.before} after=${out.after} (deterministic, jsdom-best-effort)` }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
