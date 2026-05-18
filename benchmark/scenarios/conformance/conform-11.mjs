// CONFORM-11 — apply_edits adds a top-level <section> via replace →
// structural_shape_changed with payload { shape_before, shape_after }.
//
// Spec §10 + §13 rule 9: the apply_edits path must not change top-level
// structural counts. Documents needing top-level shape changes use
// replace_document (the escape hatch).
//
// Construction: anchor a unique substring at the end of the existing
// hello div, replace with text that closes the div and inserts a new
// top-level section.

export default {
  id: 'CONFORM-11',
  category: 'CONFORM',
  description: 'edit adds top-level <section> → structural_shape_changed + payload triples',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      // The seed ends with the blank doc's </article>. Adding a top-level
      // <section> after it changes the structural shape (top-level element
      // count increases by one).
      const find = '</article>';
      if (!docBefore.endsWith(find)) {
        return { pass: false, reason: `seed default did not end with </article>, got ${JSON.stringify(docBefore.slice(-30))}` };
      }
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find, replace: '</article><section>new</section>' }] },
          docBefore,
        ),
        'structural_shape_changed',
      );
      if (!result.pass) return result;
      const ctxPayload = result.error.context;
      if (!ctxPayload?.shape_before || !ctxPayload?.shape_after) {
        return { pass: false, reason: `expected shape_before/shape_after on context, got ${JSON.stringify(ctxPayload)}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc changed' };
      return { pass: true, reason: `structural_shape_changed with payload triples (before/after)` };
    } finally {
      ctx.dispose();
    }
  },
};
