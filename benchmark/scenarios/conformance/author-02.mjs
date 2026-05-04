// AUTHOR-02 — externally-edited container with a zone removed.
//
// Spec §7.2: removing a zone (deleting both markers and the content
// between) is also external-only. On next open the zone is no longer
// presented; subsequent edits anchoring in the (now-unfrozen) region
// succeed.

export default {
  id: 'AUTHOR-02',
  category: 'AUTHOR',
  description: 'doc without zone markers → no zones presented; edit anchored in the region succeeds',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // Same body content, but with NO frozen-zone markers wrapping it.
      const doc = '<div class="hello"><h1>Hi</h1></div>\n<p>was-frozen content</p>';
      const zones = ctx.window.extractFrozenZones(doc);
      const appendix = zones.find(z => z.name === 'appendix');
      if (appendix) return { pass: false, reason: `unexpected appendix zone: ${JSON.stringify(appendix)}` };
      // Subsequent edit on the previously-frozen content should succeed.
      const result = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'was-frozen content', replace: 'edited content' }] },
        doc,
      );
      if (!result.includes('edited content')) {
        return { pass: false, reason: 'edit did not propagate to result' };
      }
      return { pass: true, reason: 'no zones presented; previously-frozen content is editable after external removal' };
    } finally {
      ctx.dispose();
    }
  },
};
