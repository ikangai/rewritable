// CONFORM-12 — edit with `replace` larger than 8 KB → replace_too_large.
//
// Spec §13 rule 5: per-edit replace cap is MAX_REPLACE (8 KB in the seed
// runtime). Caps prevent a single edit from carrying a wholesale rewrite —
// the protocol pushes large replacements to replace_document with reason.

export default {
  id: 'CONFORM-12',
  category: 'CONFORM',
  description: 'edit with `replace` > 8 KB → replace_too_large',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const big = 'x'.repeat(8 * 1024 + 1);
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'Hello, world.', replace: big }] },
          docBefore,
        ),
        'replace_too_large',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 0) {
        return { pass: false, reason: `expected editIndex=0, got ${result.error.editIndex}` };
      }
      const ctxPayload = result.error.context;
      if (ctxPayload?.cap !== 8 * 1024) {
        return { pass: false, reason: `expected cap=8192 in context, got ${ctxPayload?.cap}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: `replace_too_large with cap=${ctxPayload.cap}` };
    } finally {
      ctx.dispose();
    }
  },
};
