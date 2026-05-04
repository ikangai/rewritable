// EDGE-02 — 50 KB unique `find` succeeds.
//
// Spec §5b.5 EDGE-02: "Accept if unique in the doc and uniqueness check
// completes within a reasonable bound." No special code is reserved for
// "find too large" — the runtime should treat it like any other find.

export default {
  id: 'EDGE-02',
  category: 'EDGE',
  description: 'find of 50 KB (unique) → accepted, edit applied',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Construct a doc with one 50 KB sentinel block and other content.
      const sentinel = 'A'.repeat(50 * 1024); // 50 KB of 'A's
      const doc = '<div class="hello"><pre>' + sentinel + '</pre><p>tail</p></div>';
      const t0 = Date.now();
      const result = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: sentinel, replace: 'short' }] },
        doc,
      );
      const elapsed = Date.now() - t0;
      if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
      if (result.includes(sentinel)) return { pass: false, reason: 'sentinel still present after edit' };
      if (!result.includes('short')) return { pass: false, reason: 'replacement not present' };
      // Spec: uniqueness check should complete in reasonable time (< 1s).
      if (elapsed > 1000) {
        return { pass: false, reason: `50 KB find took ${elapsed}ms — exceeds 1000ms budget` };
      }
      return { pass: true, reason: `50 KB find applied in ${elapsed}ms` };
    } finally {
      ctx.dispose();
    }
  },
};
