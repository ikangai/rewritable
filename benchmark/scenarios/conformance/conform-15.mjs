// CONFORM-15 — replace_document with empty `reason` → malformed_envelope.
//
// Spec §6: replace_document requires a non-empty reason string explaining
// why the escape hatch was needed. The runtime treats `''` the same as
// missing.

export default {
  id: 'CONFORM-15',
  category: 'CONFORM',
  description: 'replace_document with `reason: ""` → malformed_envelope',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: '<div class="hello"><p>new</p></div>', reason: '' },
          docBefore,
        ),
        'malformed_envelope',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: 'rejected replace_document with empty reason' };
    } finally {
      ctx.dispose();
    }
  },
};
