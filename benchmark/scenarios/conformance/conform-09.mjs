// CONFORM-09 — edit that mutates the inner content of a frozen zone without
// containing reserved marker substrings → frozen_zone_corrupted.
//
// Spec §10 + §13 rule 4: an edit may pass the substring-presence check (no
// `rwa:frozen:begin` etc. in find/replace) and still corrupt a zone by
// anchoring text inside the zone. The runtime's post-apply byte-identical
// check on zone inner content is the backstop that catches this.
//
// Construction: pass applyEdits a custom currentDoc that already contains a
// frozen zone. The find anchors inside the zone (no markers), the replace
// mutates inner content. Expect frozen_zone_corrupted before the edit reaches
// IDB. Note we use applyEdits's currentDocRaw parameter (not commit + getDoc)
// because adding a zone to the doc is itself blocked by frozen_zone_corrupted
// in the live commit path (zones evolve only via external editing — AUTHOR-*).

export default {
  id: 'CONFORM-09',
  category: 'CONFORM',
  description: 'edit mutates frozen-zone inner content (no marker substrings) → frozen_zone_corrupted',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docWithZone = '<div class="hello">\n<!-- rwa:frozen:begin foo --><span>INNER</span><!-- rwa:frozen:end foo -->\n</div>';
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: '<span>INNER</span>', replace: '<span>MUTATED</span>' }] },
          docWithZone,
        ),
        'frozen_zone_corrupted',
      );
      if (!result.pass) return result;
      // Doc in IDB should still be the seed's default (commit never ran).
      const docAfter = await ctx.getDoc();
      if (docAfter.includes('MUTATED')) return { pass: false, reason: 'mutation reached IDB despite rejection' };
      return { pass: true, reason: 'frozen_zone_corrupted blocked inner-content mutation, doc unchanged' };
    } finally {
      ctx.dispose();
    }
  },
};
