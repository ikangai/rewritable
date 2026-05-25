// AUTHOR-07 — replace_document where the new doc contains an unterminated
// frozen-zone marker → frozen_zone_corrupted.
//
// Spec §7.1 + §7.2: an unpaired begin marker is reported by extractFrozenZones
// as `{ name, error: 'unterminated' }`. frozenZonesIntact (line 1748-1750)
// returns false when either side contains a zone with an error field, so
// replace_document refuses to commit a doc with a half-open zone.
//
// The new-doc-side parallel: AUTHOR-04 covers detection of unterminated zones
// in the CURRENT doc (treated as a discoverable anomaly). This scenario covers
// the runtime's refusal to TRANSITION INTO a state with an unterminated zone.

export default {
  id: 'AUTHOR-07',
  category: 'AUTHOR',
  description: 'replace_document new doc has unterminated marker → frozen_zone_corrupted',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const original = '<div class="hello"><span>I</span></div>';
      // Begin marker without a matching end — extractFrozenZones tags this
      // with error: 'unterminated' and frozenZonesIntact returns false.
      const replaced = '<div class="hello"><!-- rwa:frozen:begin orphan --><span>I</span></div>';

      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: replaced, reason: 'AUTHOR-07' },
          original,
        ),
        'frozen_zone_corrupted',
      );
      if (!result.pass) return result;
      const docAfter = await ctx.getDoc();
      if (docAfter.includes('rwa:frozen:begin orphan')) {
        return { pass: false, reason: 'orphan begin marker leaked into IDB despite rejection' };
      }
      return { pass: true, reason: 'frozen_zone_corrupted blocked unterminated zone' };
    } finally {
      ctx.dispose();
    }
  },
};
