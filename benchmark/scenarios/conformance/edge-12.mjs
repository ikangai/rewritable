// EDGE-12 — Unicode combining-mark mismatch is not normalized.
//
// Spec §4 rule 1: "find matches exactly — byte-for-byte". The runtime
// canonicalizes line endings (LF) per §5.4 but performs NO Unicode
// normalization (NFC/NFD/NFKC/NFKD). This scenario locks that contract.
//
// Construction: the doc contains "café" with U+00E9 (composed). The edit's
// find is "café" spelled as `c-a-f-e + U+0301 (combining acute accent)`
// (decomposed). Both visually identical; codepoint sequences differ.
//
// Expected: find_not_found. A future "be helpful and normalize" regression
// would silently accept the decomposed form and produce surprising results.

export default {
  id: 'EDGE-12',
  category: 'EDGE',
  description: 'combining-mark mismatch (composed vs decomposed) → find_not_found',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const composed = 'café';                  // U+0063 U+0061 U+0066 U+00E9
      const decomposed = 'café';               // U+0063 U+0061 U+0066 U+0065 U+0301
      // Sanity: visually equal, byte-distinct.
      if (composed === decomposed) {
        return { pass: false, reason: 'test setup error: composed and decomposed strings are equal' };
      }
      const docWith = `<div class="hello"><p>${composed} is open</p></div>`;

      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: decomposed, replace: 'cafeteria' }] },
          docWith,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;
      return { pass: true, reason: 'find_not_found — decomposed form was not silently normalized' };
    } finally {
      ctx.dispose();
    }
  },
};
