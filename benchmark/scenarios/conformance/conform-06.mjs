// CONFORM-06 — find that matches multiple times → find_not_unique.
//
// Spec §10 + §13 rule 6: anchors must be unique in the doc. The runtime
// reports occurrence count and surrounding-context hints so the agent's
// retry can disambiguate.

export default {
  id: 'CONFORM-06',
  category: 'CONFORM',
  description: 'find matching multiple times → find_not_unique with count + hints',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      // Construct a doc with two identical "<li>foo</li>" rows, anchored
      // inside an existing structural wrapper so structural shape doesn't
      // change. The seed's INLINE_DOC has a `<div class="hello">` wrapper;
      // we replace its h1+p with the duplicated list via replace_document
      // (cleanest way to set up an arbitrary doc state for the test).
      const setupDoc = '<div class="hello"><ul><li>foo</li><li>foo</li></ul></div>';
      await ctx.replaceDocument(
        { version: 'rwa-edit/1', doc: setupDoc, reason: 'CONFORM-06 setup' },
        await ctx.getDoc(),
      );
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '<li>foo</li>', replace: '<li>bar</li>' }] },
          docBefore,
        ),
        'find_not_unique',
      );
      if (!result.pass) return result;
      const err = result.error;
      if (err.editIndex !== 0) return { pass: false, reason: `expected editIndex=0, got ${err.editIndex}` };
      if (err.context?.count !== 2) return { pass: false, reason: `expected count=2 in context, got ${err.context?.count}` };
      if (!Array.isArray(err.context?.hints)) return { pass: false, reason: 'no hints array on err.context' };
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: `find_not_unique with count=2 and ${err.context.hints.length} hint(s)` };
    } finally {
      ctx.dispose();
    }
  },
};
