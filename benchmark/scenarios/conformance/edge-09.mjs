// EDGE-09 — network failure mid-multi-turn-loop.
//
// Spec §5b.5 EDGE-09: "Mutex is released cleanly; doc is unchanged; audit
// log entry is *not* written; user sees a clear network error."
//
// We make the first fetch fail with a TypeError (network error). The
// runtime's modify() catches throws via the outer try/catch and runs the
// `finally` block which sets modifyMutex = false. After the failed
// modify, a second modify call should not be blocked.

export default {
  id: 'EDGE-09',
  category: 'EDGE',
  description: 'fetch failure during modify → mutex released, no hist entry, second modify works',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      const before = await ctx.getDoc();
      const histBefore = await ctx.getHistory();

      // First modify: fetch throws (network error).
      let firstThrew = false;
      ctx.setFetchHandler(async () => {
        throw new TypeError('NetworkError: connection refused');
      });
      try {
        await ctx.modify('first call');
      } catch (e) {
        firstThrew = true;
      }
      // Note: modify() catches inside its own try/catch and only sets UI
      // status — it doesn't re-throw to the caller. So firstThrew may be
      // false even though fetch failed. The observable signal is whether
      // hist was written and whether mutex was released.

      const histAfter = await ctx.getHistory();
      if (histAfter.length !== histBefore.length) {
        return { pass: false, reason: `hist grew despite network failure: ${histBefore.length} → ${histAfter.length}` };
      }
      const docAfter = await ctx.getDoc();
      if (docAfter !== before) {
        return { pass: false, reason: 'doc changed despite network failure' };
      }

      // Second modify with a working fetch — must succeed (mutex released).
      let fetchHit = false;
      ctx.setFetchHandler(async () => {
        fetchHit = true;
        return {
          ok: true,
          json: async () => ({
            choices: [{
              message: {
                role: 'assistant', content: '',
                tool_calls: [{
                  id: 'call_recover', type: 'function',
                  function: {
                    name: 'apply_edits',
                    arguments: JSON.stringify({
                      version: 'rwa-edit/1',
                      edits: [{ find: 'Hello', replace: 'Hi' }],
                    }),
                  },
                }],
              },
            }],
          }),
        };
      });
      await ctx.modify('second call');
      if (!fetchHit) return { pass: false, reason: 'second modify did not reach fetch — mutex held after first failed' };
      const docFinal = await ctx.getDoc();
      if (!docFinal.includes('Hi,')) return { pass: false, reason: 'second modify did not commit' };
      return { pass: true, reason: 'mutex released after network failure; second modify succeeded; no spurious hist entry' };
    } finally {
      ctx.dispose();
    }
  },
};
