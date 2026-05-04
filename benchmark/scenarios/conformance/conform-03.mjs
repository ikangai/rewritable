// CONFORM-03 — apply_edits with empty edits array → malformed_envelope.
//
// Spec §10 + §6: an envelope must specify at least one edit; an empty batch
// has no semantics and is rejected at the schema layer alongside other
// shape violations.

export default {
  id: 'CONFORM-03',
  category: 'CONFORM',
  description: 'apply_edits with `edits: []` → malformed_envelope',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits({ version: 'rwa-edit/1', edits: [] }, docBefore),
        'malformed_envelope',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed despite rejection' };
      return { pass: true, reason: 'rejected with malformed_envelope, doc unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
