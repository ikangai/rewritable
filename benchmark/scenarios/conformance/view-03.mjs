// VIEW-03 — render output carrying a reserved runtime id is rejected at setView
// (spec §5.10 clause 4). WHY: a duplicate #rwa-lens (or #rwa-doc-mount, etc.) in
// the mounted DOM silently breaks getElementById identity resolution for the
// runtime's own chrome. setView probe-validates the would-be output and throws
// synchronously *before* activating, so a bad provider never becomes active.
export default {
  id: 'VIEW-03',
  category: 'VIEW',
  weight: 1,
  description: 'setView throws + does not activate when render output has a reserved id',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      w.runtime.provide('view', {
        kind: 'view', name: 'bad', label: 'Bad',
        render: () => '<article><div id="rwa-lens">hijack</div></article>',
      });
      let threw = null;
      try { w.runtime.setView('bad'); } catch (e) { threw = e; }
      if (!threw) {
        return { pass: false, reason: 'clause 4 violated: setView accepted output with a reserved id' };
      }
      if (!/reserved id/i.test(threw.message)) {
        return { pass: false, reason: `threw, but not a reserved-id error: ${threw.message}` };
      }
      const mount = w.document.getElementById('rwa-doc-mount');
      if (mount.classList.contains('viewmode-bad')) {
        return { pass: false, reason: 'view activated despite the throw (must not activate)' };
      }
      return { pass: true, reason: 'clause 4: reserved id rejected at setView; view did not activate' };
    } finally { ctx.dispose(); }
  },
};
