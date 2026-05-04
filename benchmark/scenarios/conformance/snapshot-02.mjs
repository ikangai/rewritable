// SNAPSHOT-02 — bootstrap byte-identity after a single edit.
//
// Same invariant as SNAPSHOT-01 but with the smallest possible delta. The
// INLINE_DOC body must change (one edit landed) and the bootstrap region
// must remain byte-identical.

import { sliceInlineDoc } from './_snapshot-util.mjs';

export default {
  id: 'SNAPSHOT-02',
  category: 'SNAPSHOT',
  description: '1 edit → bootstrap region byte-identical, INLINE_DOC body differs',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const file0 = ctx.window.buildFile(await ctx.getDoc());
      await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'Hello', replace: 'Goodbye' }] },
        await ctx.getDoc(),
      );
      const file1 = ctx.window.buildFile(await ctx.getDoc());

      const a = sliceInlineDoc(file0);
      const b = sliceInlineDoc(file1);
      if (!a || !b) return { pass: false, reason: 'could not slice INLINE_DOC literal' };

      if (a.prefix !== b.prefix) return { pass: false, reason: 'bootstrap prefix drifted' };
      if (a.suffix !== b.suffix) return { pass: false, reason: 'bootstrap suffix drifted' };
      if (a.body === b.body) return { pass: false, reason: 'INLINE_DOC body unchanged' };
      return { pass: true, reason: 'one edit propagated only into INLINE_DOC literal' };
    } finally {
      ctx.dispose();
    }
  },
};
