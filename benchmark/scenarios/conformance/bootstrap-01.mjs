// BOOTSTRAP-01 — bootstrap inviolability (rule 1).
//
// applyEdits operates on the doc string only, never the runtime/bootstrap.
// A find that exists in the bootstrap (e.g. `rwa-doc-mount` or `INLINE_DOC`)
// but not in the doc must be rejected with find_not_found. The bootstrap is
// not searched, never modified, never visible to the agent.

export default {
  id: 'BOOTSTRAP-01',
  category: 'BOOTSTRAP',
  description: 'find matching bootstrap text but not doc → find_not_found',
  weight: 1,

  async run({ harness, expectRwaError }) {
    const ctx = await harness.fresh();
    try {
      const docBefore = await ctx.getDoc();
      // 'rwa-doc-mount' is the runtime's mount-point id (CLAUDE.md reserved
      // namespaces). Lives in the bootstrap HTML — must NOT appear in the
      // seed's INLINE_DOC default (Hello, world. + .hello CSS).
      if (docBefore.includes('rwa-doc-mount')) {
        return { pass: false, reason: 'seed default unexpectedly contains rwa-doc-mount — fixture invalid' };
      }
      const result = await expectRwaError(
        ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: 'rwa-doc-mount', replace: 'x' }] },
          docBefore,
        ),
        'find_not_found',
      );
      if (!result.pass) return result;
      // Verify the bootstrap (live DOM) is intact: the runtime APIs are still callable.
      if (typeof ctx.window.applyEdits !== 'function') {
        return { pass: false, reason: 'runtime API gone — bootstrap was perturbed' };
      }
      const mount = ctx.window.document.getElementById('rwa-doc-mount');
      if (!mount) return { pass: false, reason: 'mount element gone — bootstrap was perturbed' };
      return { pass: true, reason: 'bootstrap text not searchable from applyEdits, runtime intact' };
    } finally {
      ctx.dispose();
    }
  },
};
