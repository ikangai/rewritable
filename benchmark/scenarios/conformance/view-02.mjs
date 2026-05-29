// VIEW-02 — the agent-facing source is the stored text, never the view's mounted
// output (spec §5.10 Invariant 9: invisible-by-construction). WHY: the agent must
// only ever see the document it can actually edit. If the source cache were built
// from the view-wrapped mount, the agent would receive <section class="rwa-slide">
// wrappers it never wrote and emit `find` strings absent from rwa_doc. The
// one-keystroke regression this guards is `setSourceMap(mountHtml)` instead of
// `setSourceMap(html)` in the renderDoc seam.
const tick = () => new Promise(r => setTimeout(r, 0));

export default {
  id: 'VIEW-02',
  category: 'VIEW',
  weight: 1,
  description: 'agent source cache derives from stored text, not the view output',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      if (typeof w.getCurrentDocCache !== 'function') {
        return { pass: false, reason: 'window.getCurrentDocCache test seam missing' };
      }
      w.runtime.provide('view', {
        kind: 'view', name: 'tv', label: 'TV',
        render: d => '<article><section class="rwa-slide rwa-test-wrap">' + d + '</section></article>',
      });
      w.runtime.setView('tv');
      await ctx.getDoc(); await tick(); await tick();
      const cache = w.getCurrentDocCache();
      const stored = await ctx.getDoc();
      if (/rwa-test-wrap|rwa-slide/.test(cache || '')) {
        return { pass: false, reason: 'Invariant 9 violated: agent source cache contains view wrappers' };
      }
      if (cache !== stored) {
        return { pass: false, reason: 'agent source cache diverged from stored doc text while presenting' };
      }
      return { pass: true, reason: 'Invariant 9: agent source cache == stored text, no view wrappers' };
    } finally { ctx.dispose(); }
  },
};
