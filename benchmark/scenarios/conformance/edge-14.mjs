// EDGE-14 — replace at exactly MAX_REPLACE bytes (8192) is accepted.
//
// Spec §13 rule 5: the check is `replaceRaw.length > MAX_REPLACE`
// (seed line 2927). Strictly greater — so the boundary case
// `replace.length === 8192` must succeed.
//
// CONFORM-12 already tests the +1 case (8193 → replace_too_large). This
// scenario locks the inclusive boundary so a future refactor to `>=` is
// caught by the suite.

export default {
  id: 'EDGE-14',
  category: 'EDGE',
  description: 'replace at exactly MAX_REPLACE (8192 bytes) succeeds (boundary inclusive)',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const docWith = '<div class="hello"><p>X</p></div>';
      const exact = 'a'.repeat(8 * 1024); // length === 8192
      try {
        const result = await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'X', replace: exact }] },
          docWith,
        );
        if (typeof result !== 'string') {
          return { pass: false, reason: `expected string result, got ${typeof result}` };
        }
        if (!result.includes(exact)) {
          return { pass: false, reason: 'replacement bytes missing from result' };
        }
        return { pass: true, reason: '8192-byte replace accepted at the inclusive boundary' };
      } catch (err) {
        return { pass: false, reason: `unexpected throw at boundary: code=${err?.code} (cap=${err?.context?.cap})` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
