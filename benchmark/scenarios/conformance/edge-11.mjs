// EDGE-11 — replace containing String.prototype.replace pattern tokens
// ($&, $$, $1, $`, $') is applied byte-exactly.
//
// Implementation invariant: applyEdits uses slice-concat splice, NOT
// String.prototype.replace (seed line 2948-2951, mirrored in CLI
// apply-edits.mjs:164-168). If a future refactor swapped to
// `work.replace(find, replace)`, the `$` patterns would be interpreted as
// special tokens — `$&` would expand to the matched text, `$$` to a single
// `$`, etc. — silently mangling user content like "$$amount" or "$1.00".
//
// This scenario locks the slice-vs-replace contract by feeding all five
// special tokens through and asserting byte-exact preservation.

export default {
  id: 'EDGE-11',
  category: 'EDGE',
  description: 'replace containing $&, $$, $1, $`, $\' applied byte-exactly via splice',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const docWith = '<div class="hello"><p>PRICE</p></div>';
      // All five String.prototype.replace special tokens in one replacement.
      const replacement = 'Total: $$amount = $&, $1, $`, $\'';
      try {
        const result = await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'PRICE', replace: replacement }] },
          docWith,
        );
        if (typeof result !== 'string') {
          return { pass: false, reason: `expected string result, got ${typeof result}` };
        }
        if (!result.includes(replacement)) {
          return {
            pass: false,
            reason: `byte-exact preservation failed; result snippet: ${result.slice(result.indexOf('Total'), result.indexOf('Total') + replacement.length + 10)}`,
          };
        }
        return { pass: true, reason: 'all five $-tokens preserved byte-exactly' };
      } catch (err) {
        return { pass: false, reason: `unexpected throw: code=${err?.code}, message=${err?.message}` };
      }
    } finally {
      ctx.dispose();
    }
  },
};
