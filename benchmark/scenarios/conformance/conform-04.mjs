// CONFORM-04 — edit with `find: ""` → empty_find.
//
// Spec §10: empty_find guards against degenerate edits where the runtime
// would have no anchor to match. Reported with edit_index so the agent
// knows which edit in the batch was malformed.

export default {
  id: 'CONFORM-04',
  category: 'CONFORM',
  description: 'edit with `find: ""` → empty_find',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '', replace: 'x' }] },
          docBefore,
        ),
        'empty_find',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 0) {
        return { pass: false, reason: `expected editIndex=0, got ${result.error.editIndex}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'rejected empty_find at edit_index=0' };
    } finally {
      ctx.dispose();
    }
  },
};
