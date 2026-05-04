// EDGE-04 — doc nested 200 levels deep, edit at the innermost element.
//
// Spec §5b.5 EDGE-04: "DOMParser handles it; structural-shape computation
// completes; edit succeeds." Not all HTML parsers handle deep nesting
// gracefully; this scenario exercises that path.

export default {
  id: 'EDGE-04',
  category: 'EDGE',
  description: '200-level nested <div> tree, edit at innermost — applies cleanly',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const depth = 200;
      const open = '<div>'.repeat(depth);
      const close = '</div>'.repeat(depth);
      const doc = '<div class="hello">' + open + 'INNER_TEXT' + close + '</div>';
      const t0 = Date.now();
      const result = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'INNER_TEXT', replace: 'EDITED_INNER' }] },
        doc,
      );
      const elapsed = Date.now() - t0;
      if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
      if (!result.includes('EDITED_INNER')) return { pass: false, reason: 'edit did not propagate' };
      return { pass: true, reason: `200-deep nested edit applied in ${elapsed}ms` };
    } finally {
      ctx.dispose();
    }
  },
};
