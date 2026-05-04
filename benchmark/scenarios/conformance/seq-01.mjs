// SEQ-01 — sequential application against the working copy (rule 6).
//
// Edit 2's find should match against the post-edit-1 doc state, not the
// original. The runtime mutates a local `work` variable as it iterates,
// so subsequent edits see the cumulative effect of prior edits in the
// same batch.

export default {
  id: 'SEQ-01',
  category: 'SEQ',
  description: 'second edit anchors against working copy (post-edit-1), not original',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      // Pass a custom doc containing PLACEHOLDER. Both edits succeed if
      // edit 2 sees the result of edit 1.
      const docWithPlaceholder = '<div class="hello"><p>PLACEHOLDER</p></div>';
      try {
        const result = await ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [
              { find: 'PLACEHOLDER', replace: 'INTRODUCED_BY_EDIT_1' },
              { find: 'INTRODUCED_BY_EDIT_1', replace: 'FINAL' },
            ],
          },
          docWithPlaceholder,
        );
        if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
        if (!result.includes('FINAL')) return { pass: false, reason: 'result missing FINAL' };
        if (result.includes('PLACEHOLDER') || result.includes('INTRODUCED_BY_EDIT_1')) {
          return { pass: false, reason: 'result still contains intermediate marker' };
        }
        return { pass: true, reason: 'sequential application against working copy works' };
      } catch (err) {
        return { pass: false, reason: `unexpected throw: code=${err?.code}, message=${err?.message}` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
