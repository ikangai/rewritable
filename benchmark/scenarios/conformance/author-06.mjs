// AUTHOR-06 — replace_document adds a new frozen zone not present in original
// → frozen_zone_corrupted.
//
// Spec §7.2: frozen zones evolve only via external editing of the container
// file; the runtime never adds them on its own. The seed's frozenZonesIntact
// check (line 1748) compares zone-count between original and new doc; a
// replace_document that introduces a new zone fails that count comparison.
//
// Counterpart to CONFORM-16 (which tests DROP of a zone). Together these
// pin both directions of the count-invariance contract.

export default {
  id: 'AUTHOR-06',
  category: 'AUTHOR',
  description: 'replace_document adds a frozen zone not present in original → frozen_zone_corrupted',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const original = '<div class="hello"><span>I</span></div>';
      const replaced = '<div class="hello"><!-- rwa:frozen:begin new --><span>I</span><!-- rwa:frozen:end new --></div>';

      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: replaced, reason: 'AUTHOR-06' },
          original,
        ),
        'frozen_zone_corrupted',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter.includes('rwa:frozen:begin new')) {
        return { pass: false, reason: 'new zone marker leaked into IDB despite rejection' };
      }
      return { pass: true, reason: 'frozen_zone_corrupted blocked introducing a new zone' };
    } finally {
      ctx.dispose();
    }
  },
};
