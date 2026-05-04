// CONFORM-02 — apply_edits envelope missing the `edits` field → malformed_envelope.
//
// Spec §10: "malformed_envelope — envelope shape doesn't match the schema."
// The runtime requires `edits` to be a non-empty array; absence is a shape
// violation, not an empty-batch error.

export default {
  id: 'CONFORM-02',
  category: 'CONFORM',
  description: 'apply_edits without `edits` field → malformed_envelope',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits({ version: 'rwa-edit/1' }, docBefore),
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
