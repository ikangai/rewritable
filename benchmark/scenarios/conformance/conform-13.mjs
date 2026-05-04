// CONFORM-13 — edit produces a doc larger than MAX_DOC → target_size_exceeded.
//
// Spec §13 rule 5: whole-doc cap is MAX_DOC (1 MB in the seed runtime).
// To exceed it via apply_edits while staying under per-edit MAX_REPLACE,
// stack many edits each just under the cap. We instead exercise the cap
// via replace_document because it has a single doc field that can carry
// the full payload.

export default {
  id: 'CONFORM-13',
  category: 'CONFORM',
  description: 'replace_document with doc > 1 MB → target_size_exceeded',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const oversized = '<div class="hello"><p>' + 'x'.repeat(1024 * 1024 + 1) + '</p></div>';
      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: oversized, reason: 'CONFORM-13' },
          docBefore,
        ),
        'target_size_exceeded',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'target_size_exceeded blocked oversized replace_document' };
    } finally {
      ctx.dispose();
    }
  },
};
