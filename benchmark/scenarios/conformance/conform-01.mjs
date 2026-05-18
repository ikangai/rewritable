// CONFORM-01 — apply_edits envelope with version "rwa-edit/2" → version_unsupported.
//
// Spec §10: future-version envelopes are rejected by the runtime so that an
// agent talking a newer protocol is loudly refused rather than silently
// misinterpreted under v1 semantics.

export default {
  id: 'CONFORM-01',
  category: 'CONFORM',
  description: 'apply_edits with version "rwa-edit/2" → version_unsupported',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/2', edits: [{ find: 'Untitled', replace: 'Goodbye.' }] },
          docBefore,
        ),
        'version_unsupported',
      );
      if (!result.pass) return result;

      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) {
        return { pass: false, reason: `doc changed despite rejection (before=${docBefore.length}b, after=${docAfter.length}b)` };
      }
      return { pass: true, reason: 'rejected with version_unsupported, doc unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
