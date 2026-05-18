// SHAPE-03 — anti-regression for the SHAPE-02 exemption. Adding an
// executable <script> (no type attribute, or any standard executable type)
// must STILL be rejected as a shape change. Guards against accidentally
// over-broadening the exemption — e.g. someone changing computeShape to
// skip all scripts regardless of type, which would let agents quietly
// introduce executable code under the cover of "data scripts."
//
// Setup: a plain doc with zero scripts.
// Edit: insert a <script> (no type — defaults to executable).
// Expect: structural_shape_changed.

export default {
  id: 'SHAPE-03',
  category: 'SHAPE',
  description: 'applyEdits rejects adding an executable <script> — script-count rule still active',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      // setDoc bypasses runtime validation for the fixture install.
      await ctx.setDoc('<article><p>x</p></article>');
      const docBefore = await ctx.getDoc();
      // Anchor on </article> — closing tag, not affected by data-rwa-id
      // auto-injection (only opening tags of anchorable elements get IDs).
      const result = await expectRwaError(
        ctx.applyEdits(
          {
            version: 'rwa-edit/1',
            edits: [
              { find: '</article>', replace: '<script>window.foo=1;</script></article>' },
            ],
          },
          docBefore,
        ),
        'structural_shape_changed',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter !== docBefore) {
        return { pass: false, reason: 'doc state changed despite the rejection — write should have been atomic-rejected' };
      }
      return { pass: true, reason: 'executable <script> add rejected with structural_shape_changed; doc unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
