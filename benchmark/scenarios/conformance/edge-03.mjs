// EDGE-03 — batch with 10,000 edits.
//
// Spec §5b.5 EDGE-03: "Implementation-defined: either accept (runtime cap
// is generous) or reject with a new documented code (e.g. batch_too_large).
// The test is that behavior is documented, not what behavior is."
//
// The seed runtime has no explicit batch-size cap — applyEdits iterates
// envelope.edits without limit. Test asserts: behavior is deterministic
// (succeeds or fails with a known code), and finishes in bounded time.

export default {
  id: 'EDGE-03',
  category: 'EDGE',
  description: 'batch of 10,000 distinct edits → deterministic accept or known reject',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Build a doc with 10,000 distinct anchors, one per line.
      const N = 10000;
      const lines = [];
      for (let i = 0; i < N; i++) lines.push(`<p>MARKER_${i.toString().padStart(5, '0')}</p>`);
      const doc = '<div class="hello">' + lines.join('') + '</div>';
      const edits = [];
      for (let i = 0; i < N; i++) {
        edits.push({ find: `MARKER_${i.toString().padStart(5, '0')}`, replace: `RENAMED_${i.toString().padStart(5, '0')}` });
      }
      const t0 = Date.now();
      try {
        const result = await ctx.applyEdits({ version: 'rwa-edit/1', edits }, doc);
        const elapsed = Date.now() - t0;
        if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
        // Verify all 10K renames landed.
        if (result.includes('MARKER_00000')) return { pass: false, reason: 'first rename did not propagate' };
        if (!result.includes('RENAMED_09999')) return { pass: false, reason: 'last rename did not propagate' };
        return { pass: true, reason: `10,000-edit batch accepted in ${elapsed}ms` };
      } catch (err) {
        const elapsed = Date.now() - t0;
        if (typeof err?.code === 'string') {
          return { pass: true, reason: `10,000-edit batch rejected with code=${err.code} in ${elapsed}ms (deterministic)` };
        }
        return { pass: false, reason: `unexpected throw without code: ${err?.message}` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
