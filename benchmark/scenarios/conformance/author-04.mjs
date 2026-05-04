// AUTHOR-04 — duplicate-named zones (two `begin foo` ... `end foo` pairs)
// → second zone reported with error='duplicate'.
//
// Spec §7.2: zone names are globally unique within a doc. The runtime
// rejects duplicates via extractFrozenZones tagging.

export default {
  id: 'AUTHOR-04',
  category: 'AUTHOR',
  description: 'two zones with same name → first valid, second tagged error="duplicate"',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const doc =
        '<div class="hello"></div>' +
        '<!-- rwa:frozen:begin foo --><p>1</p><!-- rwa:frozen:end foo -->' +
        '<!-- rwa:frozen:begin foo --><p>2</p><!-- rwa:frozen:end foo -->';
      const zones = ctx.window.extractFrozenZones(doc);
      const foos = zones.filter(z => z.name === 'foo');
      if (foos.length !== 2) {
        return { pass: false, reason: `expected 2 entries for "foo", got ${foos.length}` };
      }
      const valid = foos.filter(f => !f.error);
      const dup = foos.filter(f => f.error === 'duplicate');
      if (valid.length !== 1) return { pass: false, reason: `expected exactly 1 valid foo, got ${valid.length}` };
      if (dup.length !== 1) return { pass: false, reason: `expected exactly 1 duplicate foo, got ${dup.length}` };
      return { pass: true, reason: 'duplicate zone surfaced with clear error tag' };
    } finally {
      ctx.dispose();
    }
  },
};
