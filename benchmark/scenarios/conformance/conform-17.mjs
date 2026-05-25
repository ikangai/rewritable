// CONFORM-17 — replace_document with new doc containing id="rwa-doc-mount"
// → reserved_id_used.
//
// Spec §15 reserves the HTML id `#rwa-doc-mount` as the render-mount the
// runtime owns. A doc that uses that id would render itself recursively into
// the mount and shadow the runtime's contract. seeds/rewritable.html:2782
// implements `findReservedIdViolation` which queries the parsed doc for the
// id and surfaces `reserved_id_used` from both applyEdits and replaceDocument
// post-apply paths.
//
// Coverage gap: no existing CONFORM scenario tests `reserved_id_used`.

export default {
  id: 'CONFORM-17',
  category: 'CONFORM',
  description: 'replace_document introduces id="rwa-doc-mount" → reserved_id_used',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const replaced = '<article id="rwa-doc-mount"><p>oops</p></article>';

      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: replaced, reason: 'CONFORM-17' },
          docBefore,
        ),
        'reserved_id_used',
      );
      if (!result.pass) return result;
      if (result.error.context?.id !== 'rwa-doc-mount') {
        return { pass: false, reason: `expected context.id="rwa-doc-mount", got ${JSON.stringify(result.error.context)}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter.includes('id="rwa-doc-mount"')) {
        return { pass: false, reason: 'reserved id leaked into IDB despite rejection' };
      }
      return { pass: true, reason: 'reserved_id_used blocked id="rwa-doc-mount"' };
    } finally {
      ctx.dispose();
    }
  },
};
