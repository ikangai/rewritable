// AUTHOR-05 — author renames an existing zone via external editing.
//
// Spec §7.2: the renamed zone is discovered under the new name; the old
// name is no longer presented. extractFrozenZones reflects the textual
// content directly.

export default {
  id: 'AUTHOR-05',
  category: 'AUTHOR',
  description: 'externally renamed zone → new name visible, old name gone',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const before =
        '<div class="hello"></div>' +
        '<!-- rwa:frozen:begin theme --><style>x</style><!-- rwa:frozen:end theme -->';
      const after =
        '<div class="hello"></div>' +
        '<!-- rwa:frozen:begin theme-tokens --><style>x</style><!-- rwa:frozen:end theme-tokens -->';

      const zonesBefore = ctx.window.extractFrozenZones(before).filter(z => !z.error).map(z => z.name);
      const zonesAfter = ctx.window.extractFrozenZones(after).filter(z => !z.error).map(z => z.name);

      if (!zonesBefore.includes('theme')) return { pass: false, reason: `before snapshot missing 'theme': ${zonesBefore}` };
      if (zonesAfter.includes('theme')) return { pass: false, reason: `after snapshot still contains 'theme': ${zonesAfter}` };
      if (!zonesAfter.includes('theme-tokens')) return { pass: false, reason: `after snapshot missing 'theme-tokens': ${zonesAfter}` };
      return { pass: true, reason: 'rename surfaced: theme → theme-tokens' };
    } finally {
      ctx.dispose();
    }
  },
};
