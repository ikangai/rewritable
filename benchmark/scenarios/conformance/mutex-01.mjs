// MUTEX-01 — caller-held mutex visibility (rule 8).
//
// Spec rule 8: applyEdits() does not acquire the mutex itself. modify() is
// the lifecycle wrapper that owns the lock. Calling applyEdits() directly
// must run to completion without acquiring or releasing the mutex —
// otherwise calling it from within modify() would either deadlock or
// release the modify lock prematurely.
//
// Observable test: call applyEdits() directly, then call modify() with a
// stubbed-fetch that emits a successful apply_edits. modify() must work
// normally (acquires its own mutex, releases on completion). If applyEdits
// had set a global mutex without release, modify() would error out with
// "another modify in progress".

export default {
  id: 'MUTEX-01',
  category: 'MUTEX',
  description: 'applyEdits direct call does not perturb the modify mutex',
  weight: 1,

  async run({ harness }) {
    const ctx = await harness.fresh();
    try {
      // 1. Direct applyEdits — runs to completion.
      const seedDoc = await ctx.getDoc();
      const docAfterDirect = await ctx.applyEdits(
        { version: 'rwa-edit/1', edits: [{ find: 'writing', replace: 'editing' }] },
        seedDoc,
      );
      if (!docAfterDirect.includes('editing,')) {
        return { pass: false, reason: 'direct applyEdits did not modify doc' };
      }

      // 2. Now stub fetch and call modify(). If applyEdits had taken the
      // mutex without releasing it, modify() would early-return without
      // calling fetch — fetchHit would stay false.
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
                  id: 'call_mutex', type: 'function',
                  function: {
                    name: 'apply_edits',
                    arguments: JSON.stringify({
                      version: 'rwa-edit/1',
                      edits: [{ find: 'editing,', replace: 'thinking,' }],
                    }),
                  },
                }],
              },
            }],
          }),
        };
      });

      await ctx.modify('next change');
      if (!fetchHit) {
        return { pass: false, reason: 'modify() did not reach fetch — mutex was held by prior applyEdits' };
      }
      const finalDoc = await ctx.getDoc();
      if (!finalDoc.includes('thinking,')) {
        return { pass: false, reason: `modify did not commit thinking, got ${JSON.stringify(finalDoc.slice(0, 80))}` };
      }
      return { pass: true, reason: 'applyEdits ran without acquiring the modify mutex' };
    } finally {
      ctx.dispose();
    }
  },
};
