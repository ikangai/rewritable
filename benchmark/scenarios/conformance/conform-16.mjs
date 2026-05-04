// CONFORM-16 — replace_document where the new doc omits a frozen zone
// present in the prior doc → frozen_zone_corrupted.
//
// Spec §10 + §7.2: zones evolve via external editing only. Inside the
// runtime, a replace_document that drops a zone is structurally
// indistinguishable from corruption and is blocked.
//
// Construction: pass replaceDocument an originalDoc with a frozen zone (the
// runtime's frozenZonesIntact compares originalDoc → newDoc), and a newDoc
// that lacks the zone. Expect frozen_zone_corrupted before commit.

export default {
  id: 'CONFORM-16',
  category: 'CONFORM',
  description: 'replace_document drops a frozen zone present in original → frozen_zone_corrupted',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const original = '<div class="hello"><!-- rwa:frozen:begin foo --><span>I</span><!-- rwa:frozen:end foo --></div>';
      const replaced = '<div class="hello"><span>I</span></div>'; // zone removed
      const result = await expectRwaError(
        ctx.replaceDocument(
          { version: 'rwa-edit/1', doc: replaced, reason: 'CONFORM-16' },
          original,
        ),
        'frozen_zone_corrupted',
      );
      if (!result.pass) return result;
      // IDB doc should be the seed default (commit never ran).
      const docAfter = await ctx.getDoc();
      if (docAfter.includes('rwa:frozen:begin')) {
        return { pass: false, reason: 'unexpected zone marker leaked into IDB' };
      }
      return { pass: true, reason: 'frozen_zone_corrupted blocked replace_document zone removal' };
    } finally {
      ctx.dispose();
    }
  },
};
