// CONFORM-10 — edit that splits the doc's `<script>` tag → parse_error_post_apply
// OR structural_shape_changed (either is correct per spec note in §5b.1).
//
// Spec §10 + §13 rule 9: removing the closing `</script>` either makes the
// rest of the doc parse incorrectly (DOMParser flags an error) or changes
// the script count (structural shape mismatch). The runtime catches it in
// one of two places — both are valid.

export default {
  id: 'CONFORM-10',
  category: 'CONFORM',
  description: 'edit splits a <script> tag → parse_error_post_apply OR structural_shape_changed',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const docWithScript = '<div class="hello"><script>window.x=1;</script><p>after</p></div>';
      try {
        await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '</script>', replace: '' }] },
          docWithScript,
        );
        return { pass: false, reason: 'expected throw' };
      } catch (err) {
        if (err?.code === 'parse_error_post_apply' || err?.code === 'structural_shape_changed') {
          return { pass: true, reason: `runtime caught split <script> as ${err.code}` };
        }
        return { pass: false, reason: `expected parse_error_post_apply or structural_shape_changed, got ${err?.code}` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
