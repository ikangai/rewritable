// SKIN-01 — runtime applySkin/resetSkin commit a <style data-rwa-skin> block
// into the document DETERMINISTICALLY (no agent), riding the R5 non-agent commit
// path: insert (replace_document, via commitCore's doc-envelope branch) → re-skin
// (apply_edits swap, <style>-count stable, never stacks) → reset (remove). WHY:
// skinning's whole promise is that the look lives IN the document so it ships in
// the exported file and ⌘Z reverts it; a regression in the doc-envelope branch,
// the shape guard, single-block invariant, or actor passthrough surfaces here.
const tick = () => new Promise(r => setTimeout(r, 0));
const skinBlocks = (s) => (s.match(/data-rwa-skin=/g) || []).length;

export default {
  id: 'SKIN-01',
  category: 'SKIN',
  weight: 1,
  description: 'runtime applySkin insert→swap→reset round-trips, single block, actor skin:NAME',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      if (typeof w.applySkin !== 'function' || typeof w.resetSkin !== 'function') {
        return { pass: false, reason: 'runtime exposes no applySkin/resetSkin' };
      }

      // 1. apply to an unskinned container → INSERTS the block (replace_document
      //    routed through commitCore's new doc-envelope branch).
      await w.applySkin('notion-clean');
      await tick();
      let doc = await ctx.getDoc();
      if (!/<style data-rwa-skin="notion-clean">/.test(doc)) {
        return { pass: false, reason: 'applySkin did not insert the data-rwa-skin block' };
      }
      if (skinBlocks(doc) !== 1) {
        return { pass: false, reason: `expected exactly one skin block, got ${skinBlocks(doc)}` };
      }
      const hist1 = await ctx.getHistory();
      if (!hist1[0] || hist1[0].actor !== 'skin:notion-clean') {
        return { pass: false, reason: `apply hist actor mismatch: ${hist1[0] && hist1[0].actor}` };
      }

      // 2. re-skin → SWAPS in place (apply_edits, count stable, no stacking).
      await w.applySkin('editorial-serif');
      await tick();
      doc = await ctx.getDoc();
      if (!/data-rwa-skin="editorial-serif"/.test(doc) || /notion-clean/.test(doc)) {
        return { pass: false, reason: 're-skin did not replace the previous skin' };
      }
      if (skinBlocks(doc) !== 1) {
        return { pass: false, reason: 're-skin stacked skin blocks (must stay exactly one)' };
      }

      // 3. reset → REMOVES the block, document otherwise intact.
      await w.resetSkin();
      await tick();
      doc = await ctx.getDoc();
      if (skinBlocks(doc) !== 0) {
        return { pass: false, reason: 'reset left a skin block' };
      }

      return { pass: true, reason: 'applySkin insert→swap→reset round-trips; single block; actor skin:NAME' };
    } finally { ctx.dispose(); }
  },
};
