// DEG-02 — DEG-01 run twice on independent containers; endpoints must be
// byte-identical (reproducibility check).

import { stubModel, modelToFetch } from '../../runners/model.mjs';
import * as harness from '../../runners/harness.mjs';

function buildFixture() {
  const lines = Array.from({ length: 20 }, (_, i) => `<p data-i="${i}">SLOT_${String(i).padStart(2, '0')}: initial.</p>`);
  return `<article>${lines.join('\n')}</article>`;
}

function buildEdits() {
  return Array.from({ length: 20 }, (_, i) => ({
    find: `SLOT_${String(i).padStart(2, '0')}: initial.`,
    replace: `SLOT_${String(i).padStart(2, '0')}: edited (turn ${i + 1}/20).`,
  }));
}

export default {
  id: 'DEG-02',
  category: 'DEG',
  description: 'two independent runs of DEG-01; endpoints byte-identical (reproducibility)',
  weight: 3,
  N: 1,
  fixtureContent: buildFixture(),
  prompt: '(custom-run: spawns a second harness internally to compare endpoints)',
  stub: () => stubModel([{}]),
  customRun: async ({ ctx, fixture }) => {
    // Run 1: in the supplied ctx.
    const model1 = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: buildEdits() } }]);
    ctx.setFetchHandler(modelToFetch(model1).handler);
    await ctx.modify('run 1');
    const endpoint1 = await ctx.getDoc();

    // Run 2: spawn a fresh harness and replay.
    const ctx2 = await harness.fresh();
    try {
      await ctx2.setDoc(fixture);
      const model2 = stubModel([{ name: 'apply_edits', envelope: { version: 'rwa-edit/1', edits: buildEdits() } }]);
      ctx2.setFetchHandler(modelToFetch(model2).handler);
      await ctx2.modify('run 2');
      const endpoint2 = await ctx2.getDoc();
      return { endpoint1, endpoint2 };
    } finally {
      ctx2.dispose();
    }
  },
  scoreAfterCustom: (out) => {
    const ok = out.endpoint1 === out.endpoint2;
    return {
      successResult: { score: ok ? 2 : 0, total: 1, passed: ok ? 1 : 0, results: [{ ok, label: ok ? 'endpoints byte-identical' : `divergence: len1=${out.endpoint1.length} len2=${out.endpoint2.length}` }] },
      stabilityResult: { drift_bytes: 0, drift_ratio: 0, score: ok ? 2 : 0, reason: ok ? 'reproducible' : 'divergence' },
    };
  },
};
