// CONFORM-19 — find_not_found near-miss: a whitespace-only anchor mismatch
// returns a verbatim `closest` the agent can copy to succeed on retry.
//
// Spec §10 (v1.5): find_not_found is the dominant failure. The runtime now
// computes — deterministically, no model call — the closest text actually in
// the doc and classifies the miss. The WHY this matters: the near-miss is only
// useful if it is byte-for-byte re-appliable, so this scenario doesn't just
// assert the fields exist — it feeds `closest` straight back as the next `find`
// and proves the edit then succeeds. That round-trip IS the self-correction
// loop the feature exists to enable.

export default {
  id: 'CONFORM-19',
  category: 'CONFORM',
  description: 'find_not_found near-miss returns a re-appliable verbatim closest (whitespace miss)',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const doc = '<article><p>Hello   world</p></article>'; // three spaces in the doc
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'Hello world', replace: 'x' }] }, // one space
          doc,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;

      const c = result.error.context || {};
      if (c.match !== 'whitespace') {
        return { pass: false, reason: `expected match='whitespace', got ${JSON.stringify(c.match)}` };
      }
      if (c.closest !== 'Hello   world') {
        return { pass: false, reason: `expected verbatim closest 'Hello   world', got ${JSON.stringify(c.closest)}` };
      }

      // The money assertion: the suggested anchor must apply cleanly.
      const fixed = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: c.closest, replace: 'BYE' }] },
        doc,
      );
      if (fixed !== '<article><p>BYE</p></article>') {
        return { pass: false, reason: `closest did not re-apply, got ${JSON.stringify(fixed)}` };
      }
      return { pass: true, reason: 'near-miss closest is verbatim and re-applies cleanly' };
    } finally {
      ctx.dispose();
    }
  },
};
