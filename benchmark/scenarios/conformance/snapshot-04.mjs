// SNAPSHOT-04 — DOC_UUID byte-identical pre/post edits.
//
// Container spec §11: DOC_UUID is baked at creation and preserved across
// every commit because buildFile only rewrites the INLINE_DOC literal.
// After any sequence of edits, the DOC_UUID line must match.

export default {
  id: 'SNAPSHOT-04',
  category: 'SNAPSHOT',
  description: 'DOC_UUID line byte-identical before and after edits',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const uuidLine = (file) => {
        const m = file.match(/const DOC_UUID = '[0-9a-fA-F-]{36}';/);
        return m ? m[0] : null;
      };

      const file0 = ctx.window.buildFile(await ctx.getDoc());
      const uuid0 = uuidLine(file0);
      if (!uuid0) return { pass: false, reason: 'DOC_UUID line not found in initial file' };

      // Apply a few edits.
      let cur = await ctx.getDoc();
      cur = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'Hello', replace: 'Hi' }] },
        cur,
      );
      cur = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'Hi,', replace: 'Hey,' }] },
        cur,
      );

      const fileN = ctx.window.buildFile(await ctx.getDoc());
      const uuidN = uuidLine(fileN);
      if (!uuidN) return { pass: false, reason: 'DOC_UUID line not found after edits' };

      if (uuid0 !== uuidN) {
        return { pass: false, reason: `DOC_UUID drifted: ${uuid0} → ${uuidN}` };
      }
      return { pass: true, reason: `DOC_UUID byte-identical (${uuid0.length} bytes) across edits` };
    } finally {
      ctx.dispose();
    }
  },
};
