// VIEW-01 — a render mode's output is never read back into rwa_doc (spec §5.10
// Invariant 8). WHY: the entire "stored text is the source of truth, the view is
// display-only" guarantee rests here. If render output ever reached rwa_doc,
// commit/export would bake presentation markup into the document and the
// data-rwa-id / frozen-zone invariants would rot. A regression that did
// `mountHtml = ...; setDocText(mountHtml)` (or fed mountHtml to commit) fails here.
const tick = () => new Promise(r => setTimeout(r, 0));

export default {
  id: 'VIEW-01',
  category: 'VIEW',
  weight: 1,
  description: 'view render output is mount-only — rwa_doc never gains the wrapper',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      const before = await ctx.getDoc();
      w.runtime.provide('view', {
        kind: 'view', name: 'tv', label: 'TV',
        // Ignore the doc and emit fixed clean prose so the test is independent
        // of whatever the default container holds.
        render: () => '<article><section class="rwa-slide rwa-test-wrap"><p>slide</p></section></article>',
      });
      w.runtime.setView('tv');
      await ctx.getDoc(); await tick(); await tick();  // let the async re-render settle
      const mount = w.document.getElementById('rwa-doc-mount');
      if (!/rwa-test-wrap/.test(mount.innerHTML)) {
        return { pass: false, reason: 'view never rendered into the mount — cannot test Invariant 8' };
      }
      const after = await ctx.getDoc();
      if (/rwa-test-wrap|rwa-slide/.test(after)) {
        return { pass: false, reason: 'Invariant 8 violated: render output leaked into rwa_doc' };
      }
      if (after !== before) {
        return { pass: false, reason: 'activating a view mutated rwa_doc (must be display-only)' };
      }
      return { pass: true, reason: 'Invariant 8: render output stayed mount-only; rwa_doc unchanged' };
    } finally { ctx.dispose(); }
  },
};
