// CONFORM-20 — find_not_found does NOT fabricate a near-miss when none exists.
//
// Spec §10 (v1.5): `closest`/`match` are present only "when a near-miss exists".
// The WHY: a hallucinated near-miss is worse than none — it would send the
// agent chasing a wrong anchor and burn a retry. When the requested anchor
// shares nothing meaningful with the document, the failure must stay a clean
// find_not_found with no `closest` and no `match`. This is the negative control
// that keeps findClosestAnchor honest.

export default {
  id: 'CONFORM-20',
  category: 'CONFORM',
  description: 'find_not_found omits closest/match when there is no real near-miss',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const doc = '<article><p>nothing alike here</p></article>';
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'ZZZZ-totally-absent-QQQ', replace: 'x' }] },
          doc,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;

      const c = result.error.context || {};
      if (c.closest !== undefined) {
        return { pass: false, reason: `expected no closest, got ${JSON.stringify(c.closest)}` };
      }
      if (c.match !== undefined) {
        return { pass: false, reason: `expected no match, got ${JSON.stringify(c.match)}` };
      }
      return { pass: true, reason: 'no near-miss fabricated for an unrelated anchor' };
    } finally {
      ctx.dispose();
    }
  },
};
