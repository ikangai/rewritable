// SNAPSHOT-03 — no-op commit produces identical file.
//
// Container spec §11 invariant 1: buildFile(doc) is a pure function of the
// doc string and the FROZEN bootstrap. Calling buildFile twice with the
// same input must produce byte-identical output.

export default {
  id: 'SNAPSHOT-03',
  category: 'SNAPSHOT',
  description: 'two buildFile calls with same doc → byte-identical output',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const doc = await ctx.getDoc();
      const a = ctx.window.buildFile(doc);
      const b = ctx.window.buildFile(doc);
      if (a !== b) {
        return { pass: false, reason: `buildFile non-deterministic (${a.length} vs ${b.length} bytes)` };
      }
      return { pass: true, reason: `buildFile is deterministic (${a.length} bytes)` };
    } finally {
      ctx.dispose();
    }
  },
};
