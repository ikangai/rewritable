// SEQ-03 — mid-batch find_not_unique rolls back the entire batch.
//
// Symmetric to SEQ-02: rule 6 says `find` uniqueness is checked against the
// working copy at the time of that edit (§5.1 + §13). An earlier edit in
// the same batch can CREATE a second occurrence of a later edit's anchor.
// When that happens, the entire batch must be discarded.
//
// Construction: edit[0] replaces some text with a string equal to edit[1]'s
// find — producing two occurrences of edit[1].find in the working copy.
// Expect find_not_unique at editIndex=1 with count=2; rwa_doc unchanged.

export default {
  id: 'SEQ-03',
  category: 'SEQ',
  description: 'edit N-1 duplicates edit N\'s anchor — find_not_unique at N + full rollback',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const docWith = '<div class="hello"><p>foo</p><p>bar</p></div>';

      const result = await expectRwaError(
        ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [
              // After this edit, "<p>foo</p>" appears twice in the working copy.
              { find: '<p>bar</p>', replace: '<p>foo</p>' },
              { find: '<p>foo</p>', replace: '<p>baz</p>' },
            ],
          },
          docWith,
        ),
        'find_not_unique',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 1) {
        return { pass: false, reason: `expected editIndex=1, got ${result.error.editIndex}` };
      }
      if (result.error.context?.count !== 2) {
        return { pass: false, reason: `expected count=2 in context, got ${result.error.context?.count}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc mutated despite rejection' };
      return { pass: true, reason: 'find_not_unique at edit_index=1 with count=2; doc unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
