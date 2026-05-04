// EDGE-05 — `replace` containing a lone surrogate (not valid UTF-8 when
// serialized) — spec says malformed_envelope; runtime behavior is the
// honest test.
//
// Spec §5b.5 EDGE-05: "Runtime rejects with malformed_envelope (UTF-8
// decode failure) before reaching validation." JS strings are UTF-16, so
// a lone surrogate is internally well-formed but cannot be encoded to
// UTF-8 without substitution. Whether the runtime rejects or silently
// substitutes is what this scenario surfaces.

export default {
  id: 'EDGE-05',
  category: 'EDGE',
  description: 'replace with lone surrogate → malformed_envelope OR documented coercion',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      const loneHigh = '\uD800'; // unpaired high surrogate
      try {
        const result = await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'Hello', replace: 'H' + loneHigh + 'i' }] },
          docBefore,
        );
        // If the runtime accepted it, check whether the replacement was
        // coerced or preserved. Either is a finding to document.
        if (typeof result !== 'string') return { pass: false, reason: `expected string result, got ${typeof result}` };
        const containsLone = result.includes(loneHigh);
        if (containsLone) {
          return { pass: false, reason: 'runtime accepted lone surrogate and preserved it (spec: should reject as malformed_envelope)' };
        }
        return { pass: false, reason: 'runtime accepted lone surrogate and silently coerced (spec: should reject)' };
      } catch (err) {
        if (err?.code === 'malformed_envelope') {
          return { pass: true, reason: 'rejected with malformed_envelope as spec describes' };
        }
        return { pass: false, reason: `expected malformed_envelope, got ${err?.code || err?.message}` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
