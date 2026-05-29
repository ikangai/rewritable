// VIEW-05 — the render-mode subsystem is inert on a non-presentation container
// (the inertness theorem, the property that protects every existing document /
// app / workflow container). WHY: adding the kernel to the shared bootstrap must
// not change behavior unless a view is actually registered and activated. On a
// default container: provide/setView exist but no view is auto-registered, the
// mount carries no view class, and asking to activate a non-existent view throws
// cleanly rather than silently mutating render.
export default {
  id: 'VIEW-05',
  category: 'VIEW',
  weight: 1,
  description: 'inert on document containers: API present, no auto-view, unknown view throws',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      if (typeof w.runtime.provide !== 'function' || typeof w.runtime.setView !== 'function') {
        return { pass: false, reason: 'runtime.provide/setView not exposed' };
      }
      const mount = w.document.getElementById('rwa-doc-mount');
      if (mount.classList.contains('viewmode-presentation')) {
        return { pass: false, reason: 'a view auto-activated on a non-presentation container' };
      }
      if (w.document.getElementById('rwa-view-toggle')) {
        return { pass: false, reason: 'presentation chrome was built on a non-presentation container' };
      }
      let threw = null;
      try { w.runtime.setView('nope'); } catch (e) { threw = e; }
      if (!threw || !/no registered view/i.test(threw.message)) {
        return { pass: false, reason: `setView('nope') should throw 'no registered view', got: ${threw && threw.message}` };
      }
      return { pass: true, reason: 'inert: API present, no auto-view/chrome, unknown view rejected' };
    } finally { ctx.dispose(); }
  },
};
