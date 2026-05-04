// SNAPSHOT-01 — bootstrap byte-identity across 10 sequential edits.
//
// Container spec §11 invariant 1: a commit only rewrites the INLINE_DOC
// literal contents. Everything else (DOC_UUID, runtime, loader, UI HTML,
// styles) must be byte-identical from open through every commit.
//
// Approach: snapshot the file at "iteration 0" (no edits), apply 10
// sequential edits via applyEdits, snapshot again. Slice out the INLINE_DOC
// literal body from both files. The prefix and suffix (the bootstrap
// region) must match byte-for-byte.

import { sliceInlineDoc } from './_snapshot-util.mjs';

export default {
  id: 'SNAPSHOT-01',
  category: 'SNAPSHOT',
  description: '10 sequential edits → bootstrap region byte-identical, only INLINE_DOC literal differs',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const file0 = ctx.window.buildFile(await ctx.getDoc());

      // Apply 10 edits chained (each renames a unique marker).
      let cur = await ctx.getDoc();
      // Setup a doc with 10 anchorable markers so 10 sequential edits are
      // deterministic.
      const markers = Array.from({ length: 10 }, (_, i) => `MARKER_${i}`);
      const setup = '<div class="hello">' + markers.map(m => `<p>${m}</p>`).join('') + '</div>';
      cur = await ctx.replaceDocument(
        { version: 'rwa-edit/1', doc: setup, reason: 'SNAPSHOT-01 setup' },
        cur,
      );
      for (let i = 0; i < 10; i++) {
        cur = await ctx.applyEdits(
          { version: 'rwa-edit/1', edits: [{ find: `MARKER_${i}`, replace: `RENAMED_${i}` }] },
          cur,
        );
      }

      const file10 = ctx.window.buildFile(await ctx.getDoc());

      const a = sliceInlineDoc(file0);
      const b = sliceInlineDoc(file10);
      if (!a || !b) return { pass: false, reason: 'could not slice INLINE_DOC literal in one of the files' };

      if (a.prefix !== b.prefix) {
        return { pass: false, reason: `bootstrap prefix drifted (${a.prefix.length} vs ${b.prefix.length} bytes)` };
      }
      if (a.suffix !== b.suffix) {
        return { pass: false, reason: `bootstrap suffix drifted (${a.suffix.length} vs ${b.suffix.length} bytes)` };
      }
      if (a.body === b.body) {
        return { pass: false, reason: 'INLINE_DOC body unchanged after 10 edits — edits did not propagate' };
      }
      return { pass: true, reason: `bootstrap byte-identical (${a.prefix.length}+${a.suffix.length} bytes), only INLINE_DOC body differs` };
    } finally {
      ctx.dispose();
    }
  },
};
