// CONFORM-05 — find that doesn't exist in the doc → find_not_found.
//
// Spec §10: find_not_found is the most common failure in practice (the
// agent's anchor doesn't match because of whitespace, punctuation, or
// staleness). The runtime reports edit_index so retry envelopes can target
// the failed edit specifically.

export default {
  id: 'CONFORM-05',
  category: 'CONFORM',
  description: 'find with no match in doc → find_not_found',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const sentinel = 'ABSOLUTELY-NOT-IN-FIXTURE-XYZ-' + Math.random().toString(36).slice(2);
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: sentinel, replace: 'x' }] },
          docBefore,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 0) {
        return { pass: false, reason: `expected editIndex=0, got ${result.error.editIndex}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'rejected find_not_found at edit_index=0' };
    } finally {
      ctx.dispose();
    }
  },
};
