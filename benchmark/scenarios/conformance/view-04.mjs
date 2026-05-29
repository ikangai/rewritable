// VIEW-04 — render output containing <script> is rejected (spec §5.10 clause 5).
// WHY: the render path re-executes <script> in mounted HTML as main-thread code
// with no CSP (rwa-edit-spec §11). A display transform is HTML+CSS, not code; a
// first-party view that emits a script is fabricating executable content and is
// refused fail-loud (CLAUDE.md Rule 12) rather than silently run.
export default {
  id: 'VIEW-04',
  category: 'VIEW',
  weight: 1,
  description: 'setView throws when render output contains a <script>',

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const w = ctx.window;
      w.runtime.provide('view', {
        kind: 'view', name: 'scripty', label: 'Scripty',
        render: () => '<article><p>ok</p><script>window.__pwned = 1;<\/script></article>',
      });
      let threw = null;
      try { w.runtime.setView('scripty'); } catch (e) { threw = e; }
      if (!threw) {
        return { pass: false, reason: 'clause 5 violated: setView accepted output containing <script>' };
      }
      if (!/script/i.test(threw.message)) {
        return { pass: false, reason: `threw, but not a script-contract error: ${threw.message}` };
      }
      if (w.__pwned) {
        return { pass: false, reason: 'the fabricated <script> executed — sanitize ran too late' };
      }
      return { pass: true, reason: 'clause 5: <script> in render output rejected at setView, never executed' };
    } finally { ctx.dispose(); }
  },
};
