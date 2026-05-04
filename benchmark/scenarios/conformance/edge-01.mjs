// EDGE-01 — whitespace-only `find` (single newline) — behavior must be
// deterministic for a given fixture.
//
// Spec §5b.5 EDGE-01: "Either find_not_unique (if whitespace appears
// multiple times — usually true), or success. Behavior must be
// deterministic for a given fixture." Since the seed's default doc has
// many newlines, find='\n' → find_not_unique with count > 1.

export default {
  id: 'EDGE-01',
  category: 'EDGE',
  description: 'find="\\n" → find_not_unique with count matching newlines in doc',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const doc = await ctx.getDoc();
      const newlineCount = (doc.match(/\n/g) || []).length;
      if (newlineCount === 0) {
        return { pass: false, reason: 'seed default has no newlines — fixture invalid for this scenario' };
      }
      if (newlineCount === 1) {
        // Determinism: edit succeeds.
        const result = await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '\n', replace: ' ' }] },
          doc,
        );
        return { pass: typeof result === 'string', reason: `single newline replaced (n=1, deterministic)` };
      }
      // newlineCount > 1: expect find_not_unique.
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '\n', replace: ' ' }] },
          doc,
        ),
        'find_not_unique',
      );
      if (!result.pass) return result;
      const observed = result.error.context?.count;
      if (observed !== newlineCount) {
        return { pass: false, reason: `count=${observed} but doc has ${newlineCount} newlines` };
      }
      return { pass: true, reason: `find_not_unique with count=${observed} (deterministic)` };
    } finally {
      ctx.dispose();
    }
  },
};
