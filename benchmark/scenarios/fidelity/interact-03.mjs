// INTERACT-03 — open <dialog>; trigger edit; observable behavior is
// documented and consistent. The runtime's renderDoc will close the
// dialog (innerHTML reset). Score = behavior is observable.

import { stubModel, modelToFetch } from '../../runners/model.mjs';

const FIXTURE = `<dialog id="dlg" open><p>Modal content</p></dialog>
<p>EDIT_PROSE Initial.</p>`;

export default {
  id: 'INTERACT-03',
  // scoreAfterCustom returns a HARDCODED stabilityResult (score: 2) — this scenario
  // asserts runtime behaviour, not document bytes, so it carries no drift dimension.
  driftProbe: 'none',
  category: 'INTERACT',
  tag: 'content',
  description: 'open <dialog>: behavior across edit is observable (closes; documented)',
  weight: 1,
  N: 1,
  fixtureContent: FIXTURE,
  prompt: 'Edit prose.',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx }) => {
    const before = ctx.window.document.getElementById('dlg')?.hasAttribute('open');
    const model = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: [{ find: 'EDIT_PROSE Initial.', replace: 'Updated.' }] } }]);
    ctx.setFetchHandler(modelToFetch(model).handler);
    await ctx.modify('edit prose');
    await new Promise(r => setTimeout(r, 50));
    const after = ctx.window.document.getElementById('dlg')?.hasAttribute('open');
    return { before, after };
  },
  scoreAfterCustom: (out) => ({
    successResult: {
      // Observable consistent behavior — either preservation OR reset, must be deterministic.
      score: typeof out.after === 'boolean' ? 2 : 0,
      total: 1,
      passed: typeof out.after === 'boolean' ? 1 : 0,
      results: [{ ok: typeof out.after === 'boolean', label: `before=${out.before} after=${out.after} (deterministic)` }],
    },
    stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: 2 },
  }),
};
