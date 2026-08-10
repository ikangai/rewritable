// EDGE-12 — Unicode canonicalization: NFC/NFD byte forms match; nothing else does.
//
// rwa-edit v1.7 (§5.4): the canonical text form is LF + Unicode NFC, applied to
// the doc AND every find/replace at the same chokepoint. Composed vs decomposed
// byte forms of visually identical text now MATCH — that combination was the
// dominant invisible failure (NFD enters docs via paste; models emit NFC), and
// pre-v1.7 this scenario pinned the opposite contract. Updated 2026-08-10 in the
// same change as the runtime, by operator decision recorded in the spec bump
// (rwa-edit v1.6 → v1.7) and docs/plans/2026-08-10-nfc-anchor-normalization-design.md.
//
// The scenario's original job — "variance stays bounded, no fuzzy matching" —
// is preserved by the second half: canonicalization is NOT transliteration,
// case folding, or NFKC. "cafe" must still miss "café".
//
// Both fixtures are built from \u escapes so an editor normalizing THIS file
// to NFC cannot silently destroy the decomposed form.

export default {
  id: 'EDGE-12',
  category: 'EDGE',
  description: 'combining-mark forms match under NFC canonicalization; transliteration still misses',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const composed = 'caf\u00E9';                 // c a f e-acute (U+00E9)
      const decomposed = 'cafe\u0301';             // c a f e + U+0301 combining acute
      if (composed === decomposed) {
        return { pass: false, reason: 'test setup error: composed and decomposed strings are equal' };
      }
      const docWith = `<div class="hello"><p>${composed} is open</p></div>`;

      // Load-bearing half: the decomposed find matches the composed doc.
      const result = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: decomposed + ' is open', replace: composed + ' has closed' }] },
        docWith,
      );
      if (typeof result !== 'string' || !result.includes(composed + ' has closed')) {
        return { pass: false, reason: 'decomposed find did not apply against the composed doc: ' + JSON.stringify(String(result).slice(0, 80)) };
      }
      if (/[\u0300-\u036F]/.test(result)) {
        return { pass: false, reason: 'result carries decomposed sequences — output is not NFC-canonical' };
      }

      // Boundary half: canonicalization is not fuzziness. A transliterated
      // anchor ("cafe", no accent at all) is different text and must miss.
      const bounded = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'cafe is open', replace: 'x' }] },
          docWith,
        ),
        'find_not_found',
      );
      if (!bounded.pass) return bounded;

      return { pass: true, reason: 'NFC forms unified; transliteration still find_not_found' };
    } finally {
      ctx.dispose();
    }
  },
};
