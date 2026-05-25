// SEQ-02 — mid-batch find_not_found rolls back the entire batch.
//
// Spec §5.1: validation is total before apply is partial — all edits succeed
// or none do. The runtime applies sequentially against an in-memory working
// copy (§5.3), so an earlier edit can invalidate a later edit's anchor.
// When that happens, the entire batch must be discarded; the persisted doc
// must be unchanged.
//
// Construction: edit[0] deletes the text that edit[1].find depends on.
// After edit[0] commits to the working copy, edit[1].find no longer matches.
// Expect find_not_found at editIndex=1; rwa_doc and rwa_undo unchanged.

export default {
  id: 'SEQ-02',
  category: 'SEQ',
  description: 'edit N-1 invalidates edit N\'s anchor — find_not_found at N + full rollback',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const docWithBoth = '<div class="hello"><p>hello world</p></div>';
      const undoBefore = await ctx.getUndoStack();

      const result = await expectRwaError(
        ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [
              // After this edit, "world" no longer appears in the working copy.
              { find: '<p>hello world</p>', replace: '<p>greeting</p>' },
              { find: 'world', replace: 'earth' },
            ],
          },
          docWithBoth,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;
      if (result.error.editIndex !== 1) {
        return { pass: false, reason: `expected editIndex=1 (post-rollback anchor), got ${result.error.editIndex}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) return { pass: false, reason: 'doc mutated despite rejection' };
      const undoAfter = await ctx.getUndoStack();
      if (undoAfter.length !== undoBefore.length) {
        return { pass: false, reason: `undo stack grew from ${undoBefore.length} to ${undoAfter.length} — rollback incomplete` };
      }
      return { pass: true, reason: 'find_not_found at edit_index=1; rwa_doc + rwa_undo unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
