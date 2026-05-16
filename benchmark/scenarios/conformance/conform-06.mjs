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
      // change. Install via setDoc (raw IDB) — replaceDocument would route
      // through commitDoc, which (as of bootstrap 0.9) backfills data-rwa-id
      // on anchorable blocks for URL-fragment stability, producing
      // `<li data-rwa-id="…">foo</li>` and defeating the intent of the find
      // anchor `<li>foo</li>`. setDoc bypasses that backfill.
      const setupDoc = '<div class="hello"><ul><li>foo</li><li>foo</li></ul></div>';
      await ctx.setDoc(setupDoc);
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
