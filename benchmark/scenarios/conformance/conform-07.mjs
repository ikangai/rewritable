// CONFORM-07 — `find` containing reserved marker substring `rwa:frozen:begin`
// → frozen_zone_violation.
//
// Spec §13 rule 4: agent-produced anchors must not contain the reserved
// frozen-zone marker substrings. Even if the literal `rwa:frozen:begin`
// happens to appear in the doc as content (see ROB-01), agents must use a
// uniquely-anchored find that doesn't include it.

export default {
  id: 'CONFORM-07',
  category: 'CONFORM',
  description: 'find containing `rwa:frozen:begin` → frozen_zone_violation',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'x rwa:frozen:begin x', replace: 'y' }] },
          docBefore,
        ),
        'frozen_zone_violation',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 0) {
        return { pass: false, reason: `expected editIndex=0, got ${result.error.editIndex}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'rejected frozen_zone_violation on find side' };
    } finally {
      ctx.dispose();
    }
  },
};
