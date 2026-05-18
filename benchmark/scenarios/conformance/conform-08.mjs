// CONFORM-08 — `replace` containing reserved attribute marker `data-rwa-frozen`
// → frozen_zone_violation.
//
// Spec §13 rule 4: agent-produced replace bytes must not introduce reserved
// markers, including the `data-rwa-frozen` attribute (the inline frozen-zone
// declaration form).

export default {
  id: 'CONFORM-08',
  category: 'CONFORM',
  description: 'replace containing `data-rwa-frozen` → frozen_zone_violation',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [{ find: 'Untitled', replace: '<span data-rwa-frozen="x">Untitled</span>' }],
          },
          docBefore,
        ),
        'frozen_zone_violation',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'rejected frozen_zone_violation on replace side' };
    } finally {
      ctx.dispose();
    }
  },
};
