// SKIN-03 — skinning-v2 L1: applySkinL1 lands the deterministic theme block AND
// the agent's content-aware sk-* wrappers as ONE commit (one rwa_hist entry, one
// rwa_undo frame), so a single ⌘Z reverts the whole skin. The agent is stubbed at
// the fetch layer with a canned apply_edits tool call (same pattern as MUTEX-01).
// WHY: the single-commit / single-undo promise is the load-bearing invariant of
// the always-on restyle — two commits would strand a half-skinned doc after one
// undo, and the deterministic theme must compose with the agent's edits, not race
// them. Pins the compose-then-commit primitive end-to-end in jsdom.
const tick = () => new Promise(r => setTimeout(r, 0));

export default {
  id: 'SKIN-03',
  category: 'SKIN',
  weight: 1,
  description: 'L1 restyle: applySkinL1 lands theme + agent sk-* wrappers in ONE commit; one ⌘Z reverts both',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      await ctx.setDoc('<article>\n<h1>Quarterly</h1>\n<p>Q1 update line</p>\n<p>closing note</p>\n</article>');

      // Stub the agent: one apply_edits wrapping the unique anchor as an sk-* hook
      // (additive — no <style>/<script>, so the no-commit applyEdits accepts it).
      ctx.setFetchHandler(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'apply_edits', arguments: JSON.stringify({
            version: 'rwa-edit/1',
            edits: [{ find: 'Q1 update line', replace: '<span class="sk-eyebrow">Q1 update line</span>' }],
          }) } },
        ] } }] }),
      }));

      const histBefore = (await ctx.getHistory()).length;
      const undoBefore = (await ctx.getUndoStack()).length;

      await ctx.window.applySkinL1('linear-dark');
      let doc = '';
      for (let i = 0; i < 60; i++) {
        await tick(); doc = await ctx.getDoc();
        if (/class="sk-eyebrow"/.test(doc) && /data-rwa-skin="linear-dark"/.test(doc)) break;
      }

      if (!/data-rwa-skin="linear-dark"/.test(doc)) return { pass: false, reason: 'deterministic theme block not applied' };
      if (!/class="sk-eyebrow"/.test(doc)) return { pass: false, reason: 'agent sk-* wrapper not applied' };
      if ((doc.match(/data-rwa-skin=/g) || []).length !== 1) return { pass: false, reason: 'expected exactly one skin block' };

      const dHist = (await ctx.getHistory()).length - histBefore;
      const dUndo = (await ctx.getUndoStack()).length - undoBefore;
      if (dHist !== 1) return { pass: false, reason: `expected ONE rwa_hist entry, got ${dHist}` };
      if (dUndo !== 1) return { pass: false, reason: `expected ONE rwa_undo frame, got ${dUndo}` };

      const hist = await ctx.getHistory();
      if (!hist[0] || hist[0].actor !== 'skin:linear-dark') return { pass: false, reason: `commit not self-attributed skin:linear-dark (got ${hist[0] && hist[0].actor})` };

      // one ⌘Z reverts BOTH the theme block and the agent wrapper atomically.
      await ctx.window.runtime.undo();
      let undone = '';
      for (let i = 0; i < 30; i++) { await tick(); undone = await ctx.getDoc(); if (!/data-rwa-skin/.test(undone)) break; }
      if (/data-rwa-skin/.test(undone) || /sk-eyebrow/.test(undone)) return { pass: false, reason: 'one undo did not revert theme + wrapper together' };

      return { pass: true, reason: 'theme + sk-* wrappers landed in ONE commit (one hist, one undo); one ⌘Z reverted both' };
    } finally { ctx.dispose(); }
  },
};
